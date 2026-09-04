import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MAX_DIFF_FILES = 12;
const MAX_DIFF_CHARS_PER_FILE = 2_800;
const MAX_TOTAL_DIFF_CHARS = 16_000;
const MAX_OPENAPI_DIFF_CHARS = 5_000;

const sensitivePath = /(^|\/)(\.env(?:\.|$)|.*(?:secret|credential|private[-_]?key|token).*)/i;
const relevantPath = /^(apps\/|infra\/|specs\/openapi\/|tests\/|tools\/|evidence\/|docs\/|\.github\/workflows\/|README\.md$|AGENTS\.md$|package(?:-lock)?\.json$|playwright\.config\.ts$|tsconfig.*\.json$)/;

interface ImpactRule {
  pattern: RegExp;
  risk: string;
  tests: string[];
  question: string;
}

export interface KnownRiskControl {
  riskId: string;
  risk: string;
  controlId: string;
  control: string;
}

export interface RelevantDiff {
  path: string;
  patch: string;
  truncated: boolean;
}

export interface ImpactContext {
  generatedBy: 'deterministic-impact-context';
  decisionAuthority: 'human';
  changedFiles: string[];
  candidateRisks: string[];
  candidateControls: string[];
  humanQuestions: string[];
  knownRiskControls: KnownRiskControl[];
  relevantDiffs: RelevantDiff[];
  openApiChanged: boolean;
  openApiDiff: string | null;
  limits: {
    maxDiffFiles: number;
    maxCharsPerFile: number;
    maxTotalDiffChars: number;
    excludedSensitiveFileCount: number;
  };
}

const rules: ImpactRule[] = [
  {
    pattern: /^specs\/openapi\//,
    risk: 'quebra de contrato ou mudança incompatível para consumidores',
    tests: ['npm run validate:openapi', 'npm run test:contract'],
    question: 'Status, headers, schemas e compatibilidade foram revisados junto do mock?',
  },
  {
    pattern: /^apps\/control-plane-mock\//,
    risk: 'divergência comportamental, duplicidade ou perda de diagnóstico',
    tests: ['npm run test:api', 'npm run test:contract'],
    question: 'A mudança preserva idempotência, correlação e transições observáveis?',
  },
  {
    pattern: /^tests\//,
    risk: 'redução silenciosa de cobertura ou evidência fraca',
    tests: ['npm test'],
    question: 'Cada controle ainda declara o risco e produz diagnóstico útil?',
  },
  {
    pattern: /^(infra\/|apps\/control-plane-mock\/src\/(postgres-store|outbox-publisher|consumer|nats-jetstream)\.ts|tests\/resiliency\/)/,
    risk: 'falha de consistência transacional, perda de evento Outbox, degradação distribuída ou processamento duplicado',
    tests: ['npm run test:integration', 'npm run test:resiliency', 'npm test'],
    question: 'A fronteira transacional, at-least-once, retries, idempotência e recuperação sob partição de rede foram verificados?',
  },
  {
    pattern: /^(apps\/control-plane-mock\/src\/telemetry\.ts|tests\/observability\/|evidence\/observability\/|infra\/otel-collector)/,
    risk: 'perda de rastreabilidade distribuída, quebra de contexto W3C traceId, métricas divergentes ou indisponibilidade da telemetria',
    tests: ['npm run test:observability', 'npm test'],
    question: 'Os spans cobrem as 6 etapas do ciclo assíncrono, traceId propaga sem cortes e métricas refletem com precisão o comportamento?',
  },
  {
    pattern: /^tools\/ai\//,
    risk: 'regressão na QE Intelligence Layer ou violação dos guardrails de IA assistiva',
    tests: ['npm run test:unit', 'npm test'],
    question: 'A IA permanece estritamente consultiva, sem autoridade de gate e com schemas validados?',
  },
  {
    pattern: /^(docs\/|README\.md$|AGENTS\.md$)/,
    risk: 'hipótese apresentada como fato ou orientação divergente',
    tests: [],
    question: 'As afirmações usam [PUB], [VAGA], [LAB] ou [VALIDAR] e citam a fonte quando necessário?',
  },
];

function gitText(args: string[]): string {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

function lines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function redactSecrets(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED]')
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|authorization|password|secret|token)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]');
}

function truncate(value: string, maximum: number): { value: string; truncated: boolean } {
  if (value.length <= maximum) return { value, truncated: false };
  const suffix = '\n[DIFF_TRUNCATED]';
  return { value: `${value.slice(0, Math.max(0, maximum - suffix.length))}${suffix}`, truncated: true };
}

function diffRange(baseRef?: string, headRef?: string): string | undefined {
  if (baseRef && headRef) return `${baseRef}...${headRef}`;
  if (baseRef) return `${baseRef}...HEAD`;
  return undefined;
}

function changedFilesFor(range?: string): string[] {
  const changed = new Set<string>();
  if (range) {
    lines(gitText(['diff', '--name-only', range])).forEach((file) => changed.add(file));
  } else {
    lines(gitText(['diff', '--name-only'])).forEach((file) => changed.add(file));
    lines(gitText(['diff', '--cached', '--name-only'])).forEach((file) => changed.add(file));
    lines(gitText(['ls-files', '--others', '--exclude-standard'])).forEach((file) => changed.add(file));
  }
  return [...changed].sort();
}

function patchForFile(file: string, range?: string): string {
  if (range) return gitText(['diff', '--no-ext-diff', '--no-color', '--unified=1', range, '--', file]);

  const trackedPatch = [
    gitText(['diff', '--no-ext-diff', '--no-color', '--unified=1', '--', file]),
    gitText(['diff', '--cached', '--no-ext-diff', '--no-color', '--unified=1', '--', file]),
  ].filter(Boolean).join('\n');
  if (trackedPatch) return trackedPatch;

  if (existsSync(file)) {
    const content = readFileSync(file, 'utf8');
    return `--- /dev/null\n+++ b/${file}\n${content}`;
  }
  return '';
}

function relevancePriority(file: string): number {
  if (/^(apps\/|specs\/openapi\/)/.test(file)) return 0;
  if (file.startsWith('infra/')) return 1;
  if (file.startsWith('tools/')) return 2;
  if (file.startsWith('tests/')) return 3;
  if (file.startsWith('.github/workflows/')) return 4;
  if (/^(package|tsconfig|playwright)/.test(file)) return 5;
  return 6;
}

function readKnownRiskControls(path = 'docs/04-quality-risk-map.md'): KnownRiskControl[] {
  if (!existsSync(path)) return [];

  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => /^\| `RISK-[^|]+\|/.test(line))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
    .flatMap((cells) => {
      const [riskId, risk, controlId, control] = cells;
      if (!riskId || !risk || !controlId || !control) return [];
      return [{
        riskId: riskId.replaceAll('`', ''),
        risk,
        controlId: controlId.replaceAll('`', ''),
        control,
      }];
    });
}

export function collectImpactContext(environment: NodeJS.ProcessEnv = process.env): ImpactContext {
  const range = diffRange(environment.QE_IMPACT_BASE_REF, environment.QE_IMPACT_HEAD_REF);
  const detectedChangedFiles = changedFilesFor(range);
  const changedFiles = detectedChangedFiles.filter((file) => !sensitivePath.test(file));
  const matched = rules.filter((rule) => changedFiles.some((file) => rule.pattern.test(file)));
  const candidateControls = [...new Set(matched.flatMap((rule) => rule.tests))];
  const safeRelevantFiles = changedFiles
    .filter((file) => relevantPath.test(file) && !sensitivePath.test(file) && file !== 'package-lock.json')
    .sort((left, right) => relevancePriority(left) - relevancePriority(right) || left.localeCompare(right));

  const openApiFile = safeRelevantFiles.find((file) => file.startsWith('specs/openapi/'));
  const rawOpenApiDiff = openApiFile ? redactSecrets(patchForFile(openApiFile, range)) : '';
  const openApiDiff = rawOpenApiDiff ? truncate(rawOpenApiDiff, MAX_OPENAPI_DIFF_CHARS).value : null;

  let remainingCharacters = MAX_TOTAL_DIFF_CHARS;
  const relevantDiffs: RelevantDiff[] = [];
  for (const file of safeRelevantFiles.filter((path) => !path.startsWith('specs/openapi/')).slice(0, MAX_DIFF_FILES)) {
    if (remainingCharacters <= 0) break;
    const patch = redactSecrets(patchForFile(file, range));
    if (!patch) continue;
    const limited = truncate(patch, Math.min(MAX_DIFF_CHARS_PER_FILE, remainingCharacters));
    relevantDiffs.push({ path: file, patch: limited.value, truncated: limited.truncated });
    remainingCharacters -= limited.value.length;
  }

  return {
    generatedBy: 'deterministic-impact-context',
    decisionAuthority: 'human',
    changedFiles,
    candidateRisks: matched.map((rule) => rule.risk),
    candidateControls,
    humanQuestions: matched.length > 0
      ? matched.map((rule) => rule.question)
      : ['Qual comportamento e qual risco esta mudança altera?'],
    knownRiskControls: readKnownRiskControls(),
    relevantDiffs,
    openApiChanged: Boolean(openApiFile),
    openApiDiff,
    limits: {
      maxDiffFiles: MAX_DIFF_FILES,
      maxCharsPerFile: MAX_DIFF_CHARS_PER_FILE,
      maxTotalDiffChars: MAX_TOTAL_DIFF_CHARS,
      excludedSensitiveFileCount: detectedChangedFiles.length - changedFiles.length,
    },
  };
}

export function formatImpactContextMarkdown(context: ImpactContext): string {
  const output = [
    '# Contexto consultivo de impacto',
    '',
    '> Gerado deterministicamente. Não é decisão de release nem análise de um modelo.',
    '',
    '## Arquivos alterados',
    ...(context.changedFiles.length > 0
      ? context.changedFiles.map((file) => `- \`${file}\``)
      : ['- Nenhuma mudança detectada.']),
    '',
    '## Riscos candidatos',
    ...(context.candidateRisks.length > 0
      ? context.candidateRisks.map((risk) => `- ${risk}`)
      : ['- Nenhum mapeamento conhecido; revisão humana necessária.']),
    '',
    '## Controles candidatos',
    ...(context.candidateControls.length > 0
      ? context.candidateControls.map((command) => `- \`${command}\``)
      : ['- Definir manualmente conforme o risco da mudança.']),
    '',
    '## Perguntas para revisão humana',
    ...context.humanQuestions.map((question) => `- ${question}`),
  ];
  return `${output.join('\n')}\n`;
}

function requestedFormat(argumentsList: string[]): 'json' | 'markdown' {
  const inline = argumentsList.find((argument) => argument.startsWith('--format='));
  if (inline?.split('=')[1] === 'json') return 'json';
  const index = argumentsList.indexOf('--format');
  return index >= 0 && argumentsList[index + 1] === 'json' ? 'json' : 'markdown';
}

const executedFile = process.argv[1];
if (executedFile && import.meta.url === pathToFileURL(executedFile).href) {
  const context = collectImpactContext();
  process.stdout.write(
    requestedFormat(process.argv.slice(2)) === 'json'
      ? `${JSON.stringify(context, null, 2)}\n`
      : formatImpactContextMarkdown(context),
  );
}
