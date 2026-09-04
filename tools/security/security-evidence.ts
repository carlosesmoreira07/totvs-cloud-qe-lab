import type {
  ScannerEvidence,
  SecurityFinding,
  SecuritySeverity,
  SecuritySource,
} from './security-schema.js';
import { parseScannerEvidence } from './security-schema.js';

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function compactScannerText(value: unknown, fallback: string): string {
  return text(value, fallback)
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 700);
}

export function normalizeSeverity(value: unknown): SecuritySeverity {
  const normalized = String(value ?? '').toUpperCase().replace('MODERATE', 'MEDIUM');
  if (normalized.includes('CRITICAL')) return 'CRITICAL';
  if (normalized.includes('HIGH') || normalized === 'ERROR') return 'HIGH';
  if (normalized.includes('MEDIUM') || normalized === 'WARNING' || normalized.includes('WARN')) return 'MEDIUM';
  if (normalized.includes('LOW')) return 'LOW';
  return 'INFO';
}

function finding(input: Omit<SecurityFinding, 'status'> & { status?: SecurityFinding['status'] }): SecurityFinding {
  return { ...input, status: input.status ?? 'OPEN' };
}

export function deduplicateFindings(findings: SecurityFinding[]): SecurityFinding[] {
  const unique = new Map<string, SecurityFinding>();
  for (const item of findings) {
    const key = [item.source, item.ruleId, item.subject, item.location].join('|');
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()].sort((left, right) =>
    left.source.localeCompare(right.source)
    || left.ruleId.localeCompare(right.ruleId)
    || left.location.localeCompare(right.location));
}

export function parseTruffleHogOutput(raw: string): SecurityFinding[] {
  const parsed = raw.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [record(JSON.parse(line))]; } catch { return []; }
  });

  return deduplicateFindings(parsed.map((item) => {
    const sourceMetadata = record(record(record(item.SourceMetadata).Data).Filesystem);
    const detector = text(item.DetectorName ?? item.DetectorType, 'SECRET_DETECTED');
    const file = text(sourceMetadata.file, 'repository');
    const line = typeof sourceMetadata.line === 'number' ? `:${sourceMetadata.line}` : '';
    return finding({
      source: 'SECRET',
      ruleId: detector,
      severity: item.Verified === true ? 'CRITICAL' : 'HIGH',
      subject: `Possível segredo detectado por ${detector}`,
      location: `${file}${line}`,
      description: 'Material com formato de credencial foi detectado; o valor bruto foi descartado da evidência.',
      remediation: 'Revogar se aplicável, remover do histórico e usar variável de ambiente ou secret manager.',
    });
  }));
}

export function parseNpmAuditOutput(raw: string): SecurityFinding[] {
  let root: UnknownRecord;
  try { root = record(JSON.parse(raw)); } catch { return []; }
  const vulnerabilities = record(root.vulnerabilities);
  const findings: SecurityFinding[] = [];

  for (const [packageName, rawVulnerability] of Object.entries(vulnerabilities)) {
    const vulnerability = record(rawVulnerability);
    const via = Array.isArray(vulnerability.via) ? vulnerability.via : [];
    const advisories = via.map(record).filter((item) => Object.keys(item).length > 0);
    if (advisories.length === 0) advisories.push(vulnerability);

    for (const advisory of advisories) {
      const url = text(advisory.url, 'npm-audit');
      const advisoryId = url.match(/(GHSA-[\w-]+)/i)?.[1]
        ?? text(advisory.source, `${packageName}:${text(vulnerability.range, 'affected')}`);
      findings.push(finding({
        source: 'DEPENDENCY',
        ruleId: String(advisoryId),
        severity: normalizeSeverity(advisory.severity ?? vulnerability.severity),
        subject: packageName,
        location: `package-lock.json (${text(vulnerability.range, 'affected range')})`,
        description: text(advisory.title, `Vulnerabilidade reportada na dependência ${packageName}.`),
        remediation: vulnerability.fixAvailable === false
          ? 'Avaliar mitigação ou substituição; o npm não informou correção automática.'
          : 'Atualizar a dependência para uma versão corrigida e reexecutar npm audit.',
      }));
    }
  }
  return deduplicateFindings(findings);
}

export function parseSemgrepOutput(raw: string): SecurityFinding[] {
  let root: UnknownRecord;
  try { root = record(JSON.parse(raw)); } catch { return []; }
  const results = Array.isArray(root.results) ? root.results : [];
  return deduplicateFindings(results.map((rawResult) => {
    const result = record(rawResult);
    const extra = record(result.extra);
    const start = record(result.start);
    return finding({
      source: 'SAST',
      ruleId: text(result.check_id, 'SEMGREP_RULE'),
      severity: normalizeSeverity(extra.severity),
      subject: text(extra.message, 'Padrão estático de segurança'),
      location: `${text(result.path, 'source')}:${String(start.line ?? 1)}`,
      description: text(extra.message, 'Semgrep identificou um padrão que requer revisão.'),
      remediation: text(record(extra.metadata).remediation, 'Revisar o fluxo e substituir a construção insegura por uma alternativa validada.'),
    });
  }));
}

export function parseZapOutput(raw: string): SecurityFinding[] {
  let root: UnknownRecord;
  try { root = record(JSON.parse(raw)); } catch { return []; }
  const sites = Array.isArray(root.site) ? root.site : [];
  const findings: SecurityFinding[] = [];
  for (const rawSite of sites) {
    const site = record(rawSite);
    const alerts = Array.isArray(site.alerts) ? site.alerts : [];
    for (const rawAlert of alerts) {
      const alert = record(rawAlert);
      const instances = Array.isArray(alert.instances) && alert.instances.length > 0
        ? alert.instances.map(record)
        : [{}];
      for (const instance of instances) {
        const ruleId = text(alert.pluginid, text(alert.alertRef, 'ZAP_ALERT'));
        findings.push(finding({
          source: 'DAST',
          ruleId,
          severity: normalizeSeverity(alert.riskdesc ?? alert.riskcode),
          subject: text(alert.name ?? alert.alert, 'Alerta passivo ZAP'),
          location: text(instance.uri ?? instance.url, text(site['@name'], 'local mock')),
          description: compactScannerText(alert.desc, 'O baseline passivo identificou um sinal que requer revisão.'),
          remediation: ruleId === '10049'
            ? 'Aceito no LAB: respostas do control plane usam no-store deliberadamente para evitar cache de estado operacional.'
            : compactScannerText(alert.solution, 'Revisar a configuração e repetir o baseline passivo.'),
          status: ruleId === '10049' ? 'ACCEPTED_LAB' : 'OPEN',
        }));
      }
    }
  }
  return deduplicateFindings(findings);
}

export function scannerEvidence(input: {
  scanner: string;
  source: SecuritySource;
  status: ScannerEvidence['status'];
  target: string;
  findings?: SecurityFinding[];
  generatedAt?: string;
  diagnostic?: string;
}): ScannerEvidence {
  return parseScannerEvidence({
    schemaVersion: '1.0.0',
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    scanner: input.scanner,
    source: input.source,
    status: input.status,
    target: input.target,
    findings: deduplicateFindings(input.findings ?? []),
    ...(input.diagnostic ? { diagnostic: input.diagnostic.slice(0, 500) } : {}),
  });
}
