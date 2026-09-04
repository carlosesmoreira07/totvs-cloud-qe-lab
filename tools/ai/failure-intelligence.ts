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
  'A saída deve diferenciar rigorosamente: evidência observada, inferência e ausência de cobertura.',
  'NUNCA afirme que o sistema é resiliente a falhas distribuídas sem qualificação restrita aos cenários efetivamente exercitados.',
  'Para cada item em affectedRisks, consistencyConcerns, recurringPatterns, coverageGaps, recommendedExperiments e humanQuestions, forneça subject, rationale e cite explicitamente a evidência.',
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
        maxOutputTokens: 2_500,
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

function formatItems(title: string, items: AiFailureAdvisory['affectedRisks']): string[] {
  return [
    `### ${title}`,
    '',
    ...(items.length > 0
      ? items.map((item) => {
          const evidence = item.evidence.length > 0 ? ` Evidência: ${item.evidence.join('; ')}.` : '';
          return `- **${item.subject}:** ${item.rationale}.${evidence}`;
        })
      : ['- Nenhum apontamento pelo modelo.']),
    '',
  ];
}

export function formatFailureAdvisorySummary(
  outcome: FailureAdvisoryOutcome,
  metrics?: ResiliencyMetricsSummary,
): string {
  if (outcome.status === AI_FAILURE_ADVISORY_UNAVAILABLE) {
    return [
      '## QE Intelligence Layer — Failure Intelligence (AI-02)',
      '',
      `**${AI_FAILURE_ADVISORY_UNAVAILABLE}**`,
      '',
      'AI Failure Advisory indisponível — Quality Gate não afetado.',
      '',
      `Motivo técnico: \`${outcome.reason}\`.`,
      '',
    ].join('\n');
  }

  const { advisory } = outcome;
  const metricsSection = metrics
    ? [
        '### Métricas determinísticas observadas',
        '',
        `- Cenários de resiliência executados: **${metrics.totalScenarios}** (Passed: **${metrics.passed}**, Failed: **${metrics.failed}**)`,
        `- Tempo de recuperação: **mín ${metrics.durationMs.min}ms / máx ${metrics.durationMs.max}ms / média ${metrics.durationMs.avg}ms**`,
        `- Riscos exercitados: ${metrics.exercisedRisks.map((r) => `\`${r}\``).join(', ') || '_nenhum_'}`,
        `- Controles exercitados: ${metrics.exercisedControls.map((c) => `\`${c}\``).join(', ') || '_nenhum_'}`,
        `- Falhas observadas: ${metrics.observedFailures.map((f) => `\`${f}\``).join(', ') || '_nenhuma_'}`,
        '',
      ]
    : [];

  return [
    '## QE Intelligence Layer — Failure Intelligence (AI-02)',
    '',
    '> [LAB] Análise consultiva de falhas distribuídas e recuperação. Decisão de qualidade permanece humana.',
    '',
    `- Avaliação de recuperação: **${advisory.recoveryAssessment}**`,
    `- Confiança da IA: **${advisory.confidence}**`,
    `- Provedor: \`${outcome.provider}\` (Modelo: \`${outcome.model}\`, Prompt: \`${QE_FAILURE_PROMPT_VERSION}\`)`,
    '',
    ...metricsSection,
    '### Resumo da degradação e recuperação',
    '',
    advisory.failureSummary,
    '',
    ...formatItems('Riscos de resiliência impactados', advisory.affectedRisks),
    ...formatItems('Preocupações de consistência', advisory.consistencyConcerns),
    ...formatItems('Padrões recorrentes observados', advisory.recurringPatterns),
    ...formatItems('Gaps de cobertura identificados', advisory.coverageGaps),
    ...formatItems('Experimentos recomendados', advisory.recommendedExperiments),
    ...formatItems('Perguntas para revisão humana', advisory.humanQuestions),
  ].join('\n');
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
