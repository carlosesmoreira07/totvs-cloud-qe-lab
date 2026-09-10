import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ZodError } from 'zod';

import { collectImpactContext, type ImpactContext } from '../impact-context.js';
import {
  readControlResults,
  type ControlResultsSummary,
} from './advisory-analysis.js';
import {
  loadResiliencyData,
  type NormalizedResiliencyEvidence,
  type ResiliencyMetricsSummary,
} from './evidence-loader.js';
import { createOpenAiProvider, DEFAULT_QE_AI_TIMEOUT_MS } from './openai-provider.js';
import {
  AiProviderUnavailableError,
  type AiAdvisoryUnavailableReason,
  type AiProvider,
} from './provider.js';
import {
  aiFailureAdvisorySchema,
  parseAiFailureAdvisory,
  type AiFailureAdvisory,
} from './failure-schema.js';

export const AI_FAILURE_ADVISORY_UNAVAILABLE = 'AI_FAILURE_ADVISORY_UNAVAILABLE' as const;
export const QE_FAILURE_PROMPT_VERSION = 'qe-failure-advisory-v1' as const;

export const FAILURE_SYSTEM_INSTRUCTIONS = [
  'Você é uma camada consultiva de Failure Intelligence de Quality Engineering.',
  'Analise as evidências de resiliência distribuída (LAB-06), métricas determinísticas locais e diff de código.',
  'Escreva um failureSummary conciso em exatamente 1 frase.',
  'Seja altamente seletivo e proporcional: inclua no máximo 1 a 2 itens prioritários nas seções essenciais e deixe as demais seções como arrays vazios [] quando não houver anomalia.',
  'A saída deve diferenciar rigorosamente: evidência observada, inferência e ausência de cobertura.',
  'NUNCA afirme que o sistema é resiliente a falhas distribuídas sem qualificação restrita aos cenários efetivamente exercitados.',
  'Para cada item gerado, forneça subject curto, rationale concisa (1-2 frases) e cite a evidência específica.',
  'No máximo 1 pergunta humana (humanQuestions) e apenas se indispensável; deixe [] se não houver dúvida.',
  'Não aprove nem reprove a release; sua análise é estritamente consultiva para o Quality Engineer humano.',
].join(' ');

export interface FailureAdvisoryContext {
  purpose: 'failure-intelligence-advisory';
  promptVersion: typeof QE_FAILURE_PROMPT_VERSION;
  guardrails: string[];
  changes: ImpactContext;
  controlResults: ControlResultsSummary;
  resiliencyMetrics: ResiliencyMetricsSummary;
  resiliencyEvidences: NormalizedResiliencyEvidence[];
}

export type FailureAdvisoryOutcome =
  | { status: 'AVAILABLE'; provider: string; model: string; advisory: AiFailureAdvisory }
  | { status: typeof AI_FAILURE_ADVISORY_UNAVAILABLE; reason: AiAdvisoryUnavailableReason };

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new AiProviderUnavailableError('TIMEOUT_OR_PROVIDER_FAILURE', 'Failure advisory timed out')),
      timeoutMs,
    );
    operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

function readImpactContext(path?: string): ImpactContext {
  if (!path) return collectImpactContext();

  try {
    if (statSync(path).size > 100_000) return collectImpactContext();
    return JSON.parse(readFileSync(path, 'utf8')) as ImpactContext;
  } catch {
    return collectImpactContext();
  }
}

export function buildFailureAdvisoryContext(
  resiliencyDir?: string,
  impactContextPath?: string,
  testResultsPath?: string,
): FailureAdvisoryContext {
  const { evidences, metrics } = loadResiliencyData(resiliencyDir);
  const changes = readImpactContext(impactContextPath ?? process.env.QE_IMPACT_CONTEXT_PATH);
  const controlResults = readControlResults(testResultsPath ?? process.env.QE_TEST_RESULTS_PATH);

  return {
    purpose: 'failure-intelligence-advisory',
    promptVersion: QE_FAILURE_PROMPT_VERSION,
    guardrails: [
      'differentiate-evidence-vs-inference',
      'no-unqualified-resilience-claims',
      'evidence-citation-required',
      'recommendations-only',
      'no-release-decision',
      'human-review-required',
    ],
    changes,
    controlResults,
    resiliencyMetrics: metrics,
    resiliencyEvidences: evidences,
  };
}

export async function runFailureAdvisoryAnalysis(
  provider: AiProvider,
  context: FailureAdvisoryContext,
  timeoutMs = DEFAULT_QE_AI_TIMEOUT_MS,
): Promise<FailureAdvisoryOutcome> {
  try {
    const raw = await withTimeout(
      provider.analyze(context, {
        schema: aiFailureAdvisorySchema,
        schemaName: 'qe_failure_advisory',
        instructions: FAILURE_SYSTEM_INSTRUCTIONS,
        maxOutputTokens: 1100,
      }),
      timeoutMs,
    );

    return {
      status: 'AVAILABLE',
      provider: provider.name,
      model: provider.model,
      advisory: parseAiFailureAdvisory(raw),
    };
  } catch (error) {
    if (error instanceof AiProviderUnavailableError) {
      return { status: AI_FAILURE_ADVISORY_UNAVAILABLE, reason: error.reason };
    }
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return { status: AI_FAILURE_ADVISORY_UNAVAILABLE, reason: 'INVALID_RESPONSE' };
    }
    return { status: AI_FAILURE_ADVISORY_UNAVAILABLE, reason: 'TIMEOUT_OR_PROVIDER_FAILURE' };
  }
}

function formatItems(title: string, items: AiFailureAdvisory['affectedRisks'], limit = 3): string[] {
  if (items.length === 0) return [];
  return [
    `**${title}:**`,
    ...items.slice(0, limit).map((item) => {
      const evidence = item.evidence.length > 0 ? ` (${item.evidence.slice(0, 2).join('; ')})` : '';
      return `- ${item.subject}: ${item.rationale}${evidence}`;
    }),
    '',
  ];
}

export function formatFailureAdvisorySummary(
  outcome: FailureAdvisoryOutcome,
  _metrics?: ResiliencyMetricsSummary,
): string {
  if (outcome.status === AI_FAILURE_ADVISORY_UNAVAILABLE) {
    return [
      '## Failure Intelligence (AI-02)',
      '',
      `**${AI_FAILURE_ADVISORY_UNAVAILABLE}** — Quality Gate não afetado. \`${outcome.reason}\``,
      '',
      '`AI advisory · decisão humana`',
      '',
    ].join('\n');
  }

  const { advisory } = outcome;
  const lines: string[] = [
    '## Failure Intelligence (AI-02)',
    '',
    `**Resumo:** ${advisory.failureSummary}`,
    `**Impacto:** ${advisory.recoveryAssessment} · Confiança: ${advisory.confidence}`,
    '',
  ];

  const risks = [...advisory.affectedRisks, ...advisory.consistencyConcerns];
  if (risks.length > 0 && advisory.recoveryAssessment !== 'RECOVERED_CONSISTENT') {
    lines.push(`**Risco:** ${risks[0]!.subject}: ${risks[0]!.rationale}`, '');
  }

  const actions = [...advisory.recommendedExperiments, ...advisory.coverageGaps].slice(0, 2);
  if (actions.length === 1) {
    lines.push(`**Ação:** ${actions[0]!.subject}: ${actions[0]!.rationale}`, '');
  } else if (actions.length > 1) {
    lines.push('**Ação:**', ...actions.map((item) => `- ${item.subject}: ${item.rationale}`), '');
  }

  if (advisory.humanQuestions.length > 0) {
    lines.push(`**Pergunta:** ${advisory.humanQuestions[0]!.subject} — ${advisory.humanQuestions[0]!.rationale}`, '');
  }

  lines.push('`AI advisory · decisão humana`', '');
  return lines.join('\n');
}


async function main(): Promise<void> {
  const provider = createOpenAiProvider();
  const context = buildFailureAdvisoryContext();
  const outcome = await runFailureAdvisoryAnalysis(provider, context);
  process.stdout.write(`${formatFailureAdvisorySummary(outcome, context.resiliencyMetrics)}\n`);
}

const executedFile = process.argv[1];
if (executedFile && import.meta.url === pathToFileURL(executedFile).href) {
  void main().catch(() => {
    process.stdout.write(`${formatFailureAdvisorySummary({
      status: AI_FAILURE_ADVISORY_UNAVAILABLE,
      reason: 'TIMEOUT_OR_PROVIDER_FAILURE',
    })}\n`);
  });
}
