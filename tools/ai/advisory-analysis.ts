import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ZodError } from 'zod';

import { collectImpactContext, type ImpactContext } from '../impact-context.js';
import { createOpenAiProvider, DEFAULT_QE_AI_TIMEOUT_MS } from './openai-provider.js';
import {
  AiProviderUnavailableError,
  type AiAdvisoryUnavailableReason,
  type AiProvider,
} from './provider.js';
import { parseAiAdvisory, type AiAdvisory } from './schema.js';

export const AI_ADVISORY_UNAVAILABLE = 'AI_ADVISORY_UNAVAILABLE' as const;
export const QE_AI_PROMPT_VERSION = 'qe-advisory-v1' as const;
const MAX_TEST_REPORT_BYTES = 1_000_000;
const MAX_IMPACT_CONTEXT_BYTES = 100_000;
const MAX_CONTROL_RESULTS = 50;

interface ControlResult {
  name: string;
  status: string;
}

export interface ControlResultsSummary {
  source: 'playwright-json' | 'not-provided' | 'invalid';
  total: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  durationMs: number;
  controls: ControlResult[];
}

export interface AdvisoryContext {
  purpose: 'quality-engineering-advisory';
  promptVersion: typeof QE_AI_PROMPT_VERSION;
  guardrails: string[];
  changes: ImpactContext;
  controlResults: ControlResultsSummary;
}

export type AdvisoryOutcome =
  | { status: 'AVAILABLE'; provider: string; model: string; advisory: AiAdvisory }
  | { status: typeof AI_ADVISORY_UNAVAILABLE; reason: AiAdvisoryUnavailableReason };

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeControlStatus(status: string | undefined): string {
  if (status === 'expected' || status === 'passed') return 'passed';
  if (status === 'unexpected' || status === 'failed' || status === 'timedOut') return 'failed';
  return status?.slice(0, 40) ?? 'unknown';
}

function summarizeSpecs(value: unknown, results: ControlResult[]): void {
  if (!value || typeof value !== 'object' || results.length >= MAX_CONTROL_RESULTS) return;
  const record = value as Record<string, unknown>;

  if (Array.isArray(record.specs)) {
    for (const spec of record.specs) {
      if (!spec || typeof spec !== 'object' || results.length >= MAX_CONTROL_RESULTS) continue;
      const specRecord = spec as Record<string, unknown>;
      const tests = Array.isArray(specRecord.tests) ? specRecord.tests : [];
      const statuses = tests.flatMap((test) => {
        if (!test || typeof test !== 'object') return [];
        const testRecord = test as Record<string, unknown>;
        if (typeof testRecord.status === 'string') return [testRecord.status];
        const attempts = Array.isArray(testRecord.results) ? testRecord.results : [];
        return attempts.flatMap((attempt) => {
          if (!attempt || typeof attempt !== 'object') return [];
          const status = (attempt as Record<string, unknown>).status;
          return typeof status === 'string' ? [status] : [];
        });
      });
      results.push({
        name: typeof specRecord.title === 'string' ? specRecord.title.slice(0, 200) : 'controle sem título',
        status: normalizeControlStatus(statuses.at(-1)),
      });
    }
  }

  if (Array.isArray(record.suites)) {
    for (const suite of record.suites) summarizeSpecs(suite, results);
  }
}

export function summarizePlaywrightReport(report: unknown): ControlResultsSummary {
  if (!report || typeof report !== 'object') {
    return emptyControlResults('invalid');
  }

  const record = report as Record<string, unknown>;
  const stats = record.stats && typeof record.stats === 'object'
    ? record.stats as Record<string, unknown>
    : {};
  const controls: ControlResult[] = [];
  summarizeSpecs(record, controls);

  const passed = numeric(stats.expected);
  const failed = numeric(stats.unexpected);
  const flaky = numeric(stats.flaky);
  const skipped = numeric(stats.skipped);
  return {
    source: 'playwright-json',
    total: passed + failed + flaky + skipped,
    passed,
    failed,
    flaky,
    skipped,
    durationMs: numeric(stats.duration),
    controls,
  };
}

function emptyControlResults(source: ControlResultsSummary['source']): ControlResultsSummary {
  return { source, total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0, durationMs: 0, controls: [] };
}

export function readControlResults(path?: string): ControlResultsSummary {
  if (!path) return emptyControlResults('not-provided');

  try {
    if (statSync(path).size > MAX_TEST_REPORT_BYTES) return emptyControlResults('invalid');
    return summarizePlaywrightReport(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return emptyControlResults('invalid');
  }
}

function readImpactContext(path?: string): ImpactContext {
  if (!path) return collectImpactContext();

  try {
    if (statSync(path).size > MAX_IMPACT_CONTEXT_BYTES) return collectImpactContext();
    return JSON.parse(readFileSync(path, 'utf8')) as ImpactContext;
  } catch {
    return collectImpactContext();
  }
}

export function buildAdvisoryContext(
  changes: ImpactContext = readImpactContext(process.env.QE_IMPACT_CONTEXT_PATH),
  controlResults: ControlResultsSummary = readControlResults(process.env.QE_TEST_RESULTS_PATH),
): AdvisoryContext {
  return {
    purpose: 'quality-engineering-advisory',
    promptVersion: QE_AI_PROMPT_VERSION,
    guardrails: [
      'recommendations-only',
      'no-release-decision',
      'no-code-or-test-changes',
      'no-command-execution',
      'human-review-required',
    ],
    changes,
    controlResults,
  };
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new AiProviderUnavailableError('TIMEOUT_OR_PROVIDER_FAILURE', 'AI advisory timed out')),
      timeoutMs,
    );
    operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

export async function runAdvisoryAnalysis(
  provider: AiProvider,
  context: AdvisoryContext,
  timeoutMs = DEFAULT_QE_AI_TIMEOUT_MS,
): Promise<AdvisoryOutcome> {
  try {
    const raw = await withTimeout(provider.analyze(context), timeoutMs);
    return {
      status: 'AVAILABLE',
      provider: provider.name,
      model: provider.model,
      advisory: parseAiAdvisory(raw),
    };
  } catch (error) {
    if (error instanceof AiProviderUnavailableError) {
      return { status: AI_ADVISORY_UNAVAILABLE, reason: error.reason };
    }
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return { status: AI_ADVISORY_UNAVAILABLE, reason: 'INVALID_RESPONSE' };
    }
    return { status: AI_ADVISORY_UNAVAILABLE, reason: 'TIMEOUT_OR_PROVIDER_FAILURE' };
  }
}

function advisoryItems(title: string, items: AiAdvisory['coverageGaps']): string[] {
  return [
    `### ${title}`,
    '',
    ...(items.length > 0
      ? items.map((item) => {
          const evidence = item.evidence.length > 0 ? ` Evidência: ${item.evidence.join('; ')}.` : '';
          return `- **${item.subject}:** ${item.rationale}.${evidence}`;
        })
      : ['- Nenhum item sugerido pelo modelo.']),
    '',
  ];
}

export function formatAdvisorySummary(outcome: AdvisoryOutcome): string {
  if (outcome.status === AI_ADVISORY_UNAVAILABLE) {
    return [
      '## QE Intelligence Layer — advisory',
      '',
      `**${AI_ADVISORY_UNAVAILABLE}**`,
      '',
      'AI Advisory indisponível — Quality Gate não afetado.',
      '',
      `Motivo técnico: \`${outcome.reason}\`.`,
      '',
    ].join('\n');
  }

  const { advisory } = outcome;
  return [
    '## QE Intelligence Layer — advisory',
    '',
    '> [LAB] Recomendação probabilística. Não aprova nem reprova a mudança; a decisão é humana.',
    '',
    `- Impacto sugerido: **${advisory.impact}**`,
    `- Confiança: **${advisory.confidence}**`,
    `- Provedor: \`${outcome.provider}\``,
    `- Modelo: \`${outcome.model}\``,
    `- Prompt: \`${QE_AI_PROMPT_VERSION}\``,
    '',
    ...advisoryItems('Riscos impactados', advisory.impactedRisks),
    ...advisoryItems('Controles impactados', advisory.impactedControls),
    ...advisoryItems('Gaps de cobertura', advisory.coverageGaps),
    ...advisoryItems('Testes suspeitos', advisory.suspiciousTests),
    ...advisoryItems('Preocupações de segurança', advisory.securityConcerns),
    ...advisoryItems('Checks recomendados', advisory.recommendedChecks),
    ...advisoryItems('Perguntas para revisão humana', advisory.humanQuestions),
  ].join('\n');
}

async function main(): Promise<void> {
  const provider = createOpenAiProvider();
  const outcome = await runAdvisoryAnalysis(provider, buildAdvisoryContext());
  process.stdout.write(`${formatAdvisorySummary(outcome)}\n`);
}

const executedFile = process.argv[1];
if (executedFile && import.meta.url === pathToFileURL(executedFile).href) {
  void main().catch(() => {
    process.stdout.write(`${formatAdvisorySummary({
      status: AI_ADVISORY_UNAVAILABLE,
      reason: 'TIMEOUT_OR_PROVIDER_FAILURE',
    })}\n`);
  });
}
