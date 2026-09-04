import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  deduplicateFindings,
  parseNpmAuditOutput,
  parseSemgrepOutput,
  parseTruffleHogOutput,
  parseZapOutput,
  scannerEvidence,
} from './security-evidence.js';
import type { ScannerEvidence, SecurityFinding, SecuritySource } from './security-schema.js';
import { buildSecuritySummary, formatSecuritySummary, securityGatePassed } from './security-summary.js';

const SCANNER_TIMEOUT_MS = 240_000;
const API_PORT = 4011;
const EVIDENCE_FILES: Record<SecuritySource, string> = {
  SECRET: 'secret-scan.json',
  DEPENDENCY: 'dependency-scan.json',
  SAST: 'sast.json',
  DAST: 'dast.json',
};

interface CommandResult {
  status: number | null;
  stdout: string;
  error?: Error;
}

function execute(command: string, args: string[], cwd: string): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    timeout: SCANNER_TIMEOUT_MS,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    ...(result.error ? { error: result.error } : {}),
  };
}

function unavailable(source: SecuritySource, scanner: string, target: string, result: CommandResult): ScannerEvidence {
  const diagnostic = result.error?.message.includes('ETIMEDOUT')
    ? 'Scanner excedeu o timeout local.'
    : `Scanner indisponível ou encerrou com código ${String(result.status)}.`;
  return scannerEvidence({ scanner, source, status: 'UNAVAILABLE', target, diagnostic });
}

function scanSecrets(root: string): ScannerEvidence {
  const filesystemResult = execute('docker', [
    'run', '--rm',
    '--volume', `${root}:/repo:ro`,
    'trufflesecurity/trufflehog:3.97.1',
    'filesystem', '/repo', '--json', '--no-update', '--no-verification',
    '--exclude-paths=/repo/security/trufflehog-exclude.txt',
  ], root);
  if (filesystemResult.status !== 0) return unavailable('SECRET', 'TruffleHog 3.97.1', 'working tree local', filesystemResult);
  const historyResult = execute('docker', [
    'run', '--rm',
    '--volume', `${root}:/repo:ro`,
    'trufflesecurity/trufflehog:3.97.1',
    'git', 'file:///repo', '--json', '--no-update', '--no-verification',
    '--exclude-paths=/repo/security/trufflehog-exclude.txt',
  ], root);
  if (historyResult.status !== 0) return unavailable('SECRET', 'TruffleHog 3.97.1', 'histórico Git local', historyResult);
  return scannerEvidence({
    scanner: 'TruffleHog 3.97.1', source: 'SECRET', status: 'EXECUTED',
    target: 'working tree e histórico Git locais (fixtures e artefatos excluídos do filesystem)',
    findings: parseTruffleHogOutput(`${filesystemResult.stdout}\n${historyResult.stdout}`),
  });
}

function scanDependencies(root: string): ScannerEvidence {
  const npmCli = process.env.npm_execpath;
  const result = npmCli
    ? execute(process.execPath, [npmCli, 'audit', '--json'], root)
    : execute('npm', ['audit', '--json'], root);
  const findings = parseNpmAuditOutput(result.stdout);
  if ((result.status !== 0 && result.status !== 1) || (!result.stdout.trim() && result.error)) {
    return unavailable('DEPENDENCY', 'npm audit', 'package-lock.json', result);
  }
  return scannerEvidence({
    scanner: 'npm audit', source: 'DEPENDENCY', status: 'EXECUTED',
    target: 'package-lock.json', findings,
  });
}

function scanStaticAnalysis(root: string): ScannerEvidence {
  const result = execute('docker', [
    'run', '--rm',
    '--volume', `${root}:/src:ro`,
    'semgrep/semgrep:1.172.0',
    'semgrep', 'scan', '--config', '/src/security/semgrep-rules.yml', '--json', '--metrics=off',
    '--exclude', 'node_modules', '--exclude', 'dist', '--exclude', 'tests/fixtures/security',
    '/src/apps', '/src/tools',
  ], root);
  if (result.status !== 0) return unavailable('SAST', 'Semgrep 1.172.0', 'apps/ e tools/', result);
  return scannerEvidence({
    scanner: 'Semgrep 1.172.0', source: 'SAST', status: 'EXECUTED',
    target: 'apps/ e tools/ com regras locais versionadas', findings: parseSemgrepOutput(result.stdout),
  });
}

async function waitForHealth(url: string): Promise<boolean> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return true;
    } catch {
      // Polling determinístico até o prazo; nenhum sleep fixo é usado como decisão.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function stopProcess(child: ChildProcess | undefined): void {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
}

async function scanDast(root: string): Promise<ScannerEvidence> {
  const localTarget = `http://127.0.0.1:${API_PORT}/health`;
  const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const child = spawn(process.execPath, [tsxCli, path.join(root, 'apps', 'control-plane-mock', 'src', 'server.ts')], {
    cwd: root,
    env: { ...process.env, PORT: String(API_PORT), HOST: '127.0.0.1', DATABASE_URL: '' },
    stdio: 'ignore',
    windowsHide: true,
  });

  try {
    if (!await waitForHealth(localTarget)) {
      return scannerEvidence({
        scanner: 'OWASP ZAP 2.17.0 baseline', source: 'DAST', status: 'UNAVAILABLE',
        target: localTarget, diagnostic: 'Mock local não ficou saudável dentro do prazo.',
      });
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qe-zap-'));
    if (process.platform !== 'win32') fs.chmodSync(tempDir, 0o777);
    const reportPath = path.join(tempDir, 'zap-report.json');
    const containerTarget = process.platform === 'win32'
      ? `http://host.docker.internal:${API_PORT}/health`
      : localTarget;
    const networkArgs = process.platform === 'win32' ? [] : ['--network', 'host'];
    const result = execute('docker', [
      'run', '--rm', ...networkArgs,
      '--volume', `${tempDir}:/zap/wrk:rw`,
      'ghcr.io/zaproxy/zaproxy:2.17.0',
      'zap-baseline.py', '-t', containerTarget, '-J', 'zap-report.json', '-I', '-m', '1',
    ], root);
    const raw = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8') : '';
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (![0, 1, 2].includes(result.status ?? -1)) {
      return unavailable('DAST', 'OWASP ZAP 2.17.0 baseline', localTarget, result);
    }
    if (!raw) {
      return scannerEvidence({
        scanner: 'OWASP ZAP 2.17.0 baseline', source: 'DAST', status: 'UNAVAILABLE',
        target: localTarget, diagnostic: 'ZAP encerrou sem produzir o relatório JSON esperado.',
      });
    }
    const findings = parseZapOutput(raw).map((item) => ({
      ...item,
      location: item.location.replace('host.docker.internal', '127.0.0.1'),
    }));
    return scannerEvidence({
      scanner: 'OWASP ZAP 2.17.0 baseline', source: 'DAST', status: 'EXECUTED',
      target: `${localTarget} (somente mock local)`, findings,
    });
  } finally {
    stopProcess(child);
  }
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function runSecurityScanners(root = process.cwd()): Promise<ReturnType<typeof buildSecuritySummary>> {
  const targetDir = path.join(root, 'evidence', 'security');
  const evidences = [
    scanSecrets(root),
    scanDependencies(root),
    scanStaticAnalysis(root),
    await scanDast(root),
  ];
  for (const evidence of evidences) writeJson(path.join(targetDir, EVIDENCE_FILES[evidence.source]), evidence);

  const findings: SecurityFinding[] = deduplicateFindings(evidences.flatMap((item) => item.findings));
  const generatedAt = new Date().toISOString();
  writeJson(path.join(targetDir, 'findings.json'), { schemaVersion: '1.0.0', generatedAt, findings });
  const summary = buildSecuritySummary(evidences, { generatedAt });
  writeJson(path.join(targetDir, 'summary.json'), summary);
  return summary;
}

async function main(): Promise<void> {
  const summary = await runSecurityScanners();
  process.stdout.write(`${formatSecuritySummary(summary)}\n`);
  if (!securityGatePassed(summary)) process.exitCode = 1;
}

const executedFile = process.argv[1];
if (executedFile && import.meta.url === pathToFileURL(executedFile).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`Security pack indisponível: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
