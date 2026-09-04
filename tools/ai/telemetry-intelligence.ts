import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ZodError } from 'zod';

import { collectImpactContext, type ImpactContext } from '../impact-context.js';
import {
  readControlResults,
  type ControlResultsSummary,
} from './advisory-analysis.js';
import { createOpenAiProvider, DEFAULT_QE_AI_TIMEOUT_MS } from './openai-provider.js';
import {
  AiProviderUnavailableError,
  type AiAdvisoryUnavailableReason,
  type AiProvider,
} from './provider.js';
import {
  loadTelemetryData,
  type DeterministicTelemetryCorrelation,
  type NormalizedObservabilityEvidence,
} from './telemetry-evidence-loader.js';
import {
  aiTelemetryAdvisorySchema,
  parseAiTelemetryAdvisory,
  type AiTelemetryAdvisory,
  type TelemetryFindingItem,
} from './telemetry-schema.js';
import type { NormalizedResiliencyEvidence } from './evidence-loader.js';

export const AI_TELEMETRY_ADVISORY_UNAVAILABLE = 'AI_TELEMETRY_ADVISORY_UNAVAILABLE' as const;
export const QE_TELEMETRY_PROMPT_VERSION = 'qe-telemetry-advisory-v1' as const;

export const TELEMETRY_SYSTEM_INSTRUCTIONS = [
  'Você é uma camada consultiva de Telemetry & Trace Intelligence de Quality Engineering.',
  'Analise as evidências de traces OpenTelemetry (LAB-07), métricas determinísticas locais, falhas de resiliência (LAB-06) e diff de código.',
  'REGRA RÍGIDA ANTI-ALUCINAÇÃO: Para CADA item retornado em qualquer seção, defina obrigatoriamente o campo classification como um dos três valores exatos:',
  '- OBSERVED: evidência ou anomalia diretamente presente e comprovável nos spans, atributos, status ERROR ou contadores de métricas;',
  '- INFERRED: hipótese fundamentada na correlação lógica de múltiplos sinais observados (ex: provável ponto de degradação na fronteira de comunicação);',
  '- GAP: ausência de evidência, métrica, span ou cobertura de instrumentação.',
  'PROIBIÇÃO DE CAUSA RAIZ CATEGÓRICA: Nunca afirme que um componente ou serviço foi a "causa raiz definitiva" sem prova matemática/determinística direta.',
  'Para cada finding, forneça subject, rationale concisa, cite a evidência específica (ex: nome do span, traceId, métrica ou arquivo) e classifique corretamente.',
  'Identifique se há novas rotas sem trace, mudanças sem correlationId, spans esperados ausentes ou métricas que divergiram do comportamento.',
  'Não aprove nem reprove a release; sua análise é estritamente consultiva para o Quality Engineer humano.',
].join(' ');

export interface TelemetryAdvisoryContext {
  purpose: 'telemetry-intelligence-advisory';
  promptVersion: typeof QE_TELEMETRY_PROMPT_VERSION;
  guardrails: string[];
  changes: ImpactContext;
  controlResults: ControlResultsSummary;
  telemetryCorrelation: DeterministicTelemetryCorrelation;
  observabilityEvidences: NormalizedObservabilityEvidence[];
  resiliencyEvidences: NormalizedResiliencyEvidence[];
}

export type TelemetryAdvisoryOutcome =
  | { status: 'AVAILABLE'; provider: string; model: string; advisory: AiTelemetryAdvisory }
  | { status: typeof AI_TELEMETRY_ADVISORY_UNAVAILABLE; reason: AiAdvisoryUnavailableReason };

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new AiProviderUnavailableError('TIMEOUT_OR_PROVIDER_FAILURE', 'Telemetry advisory timed out')),
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

export function buildTelemetryAdvisoryContext(
  observabilityDir?: string,
  resiliencyDir?: string,
  impactContextPath?: string,
  testResultsPath?: string,
): TelemetryAdvisoryContext {
  const { observabilityEvidences, resiliencyEvidences, correlation } = loadTelemetryData(
    observabilityDir ?? process.env.QE_OBSERVABILITY_DIR,
    resiliencyDir ?? process.env.QE_RESILIENCY_DIR,
  );
  const changes = readImpactContext(impactContextPath ?? process.env.QE_IMPACT_CONTEXT_PATH);
  const controlResults = readControlResults(testResultsPath ?? process.env.QE_TEST_RESULTS_PATH);

  return {
    purpose: 'telemetry-intelligence-advisory',
    promptVersion: QE_TELEMETRY_PROMPT_VERSION,
    guardrails: [
      'differentiate-observed-inferred-gap',
      'no-unqualified-root-cause-claims',
      'evidence-citation-required',
      'strict-finding-classification',
      'recommendations-only',
      'no-release-decision',
      'human-review-required',
    ],
    changes,
    controlResults,
    telemetryCorrelation: correlation,
    observabilityEvidences,
    resiliencyEvidences,
  };
}

export async function runTelemetryAdvisoryAnalysis(
  provider: AiProvider,
  context: TelemetryAdvisoryContext,
  timeoutMs = DEFAULT_QE_AI_TIMEOUT_MS,
): Promise<TelemetryAdvisoryOutcome> {
  try {
    const raw = await withTimeout(
      provider.analyze(context, {
        schema: aiTelemetryAdvisorySchema,
        schemaName: 'qe_telemetry_advisory',
        instructions: TELEMETRY_SYSTEM_INSTRUCTIONS,
        maxOutputTokens: 2_500,
      }),
      timeoutMs,
    );

    return {
      status: 'AVAILABLE',
      provider: provider.name,
      model: provider.model,
      advisory: parseAiTelemetryAdvisory(raw),
    };
  } catch (error) {
    if (error instanceof AiProviderUnavailableError) {
      return { status: AI_TELEMETRY_ADVISORY_UNAVAILABLE, reason: error.reason };
    }
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return { status: AI_TELEMETRY_ADVISORY_UNAVAILABLE, reason: 'INVALID_RESPONSE' };
    }
    return { status: AI_TELEMETRY_ADVISORY_UNAVAILABLE, reason: 'TIMEOUT_OR_PROVIDER_FAILURE' };
  }
}

function formatItems(title: string, items: TelemetryFindingItem[]): string[] {
  return [
    `### ${title}`,
    '',
    ...(items.length > 0
      ? items.map((item) => {
          const badge = `\`[${item.classification}]\``;
          const evidence = item.evidence.length > 0 ? ` Evidência: ${item.evidence.join('; ')}.` : '';
          return `- ${badge} **${item.subject}:** ${item.rationale}.${evidence}`;
        })
      : ['- Nenhum apontamento pelo modelo.']),
    '',
  ];
}

export function formatTelemetryAdvisorySummary(
  outcome: TelemetryAdvisoryOutcome,
  correlation?: DeterministicTelemetryCorrelation,
): string {
  if (outcome.status === AI_TELEMETRY_ADVISORY_UNAVAILABLE) {
    return [
      '## QE Intelligence Layer — Telemetry & Trace Intelligence (AI-03)',
      '',
      `**${AI_TELEMETRY_ADVISORY_UNAVAILABLE}**`,
      '',
      'AI Telemetry Advisory indisponível — Quality Gate não afetado.',
      '',
      `Motivo técnico: \`${outcome.reason}\`.`,
      '',
    ].join('\n');
  }

  const { advisory } = outcome;
  const metricsSection = correlation
    ? [
        '### Correlação determinística observada',
        '',
        `- Traces analisados: **${correlation.totalTraces}** (Cenários de observabilidade: **${correlation.totalObservabilityScenarios}**, Resiliência: **${correlation.totalResiliencyScenarios}**)`,
        `- Spans observados na cadeia: ${correlation.observedSpans.map((s) => `\`${s}\``).join(', ') || '_nenhum_'}`,
        `- Traces com status ERROR: **${correlation.errorTraces.length}**${
          correlation.errorTraces.length > 0
            ? ` (${correlation.errorTraces.map((e) => `\`${e.spanName}\` em ${e.scenario}`).join(', ')})`
            : ''
        }`,
        `- Quebras de fluxo (spans esperados ausentes): **${correlation.missingSpans.length}** cenários`,
        `- Métricas agregadas: HTTP reqs: **${correlation.metricsSummary.httpRequestsTotal}** | HTTP errs: **${correlation.metricsSummary.httpErrorsTotal}** | Outbox pending: **${correlation.metricsSummary.outboxPendingCount}** | Publish fails: **${correlation.metricsSummary.outboxPublishFailuresTotal}** | Processed: **${correlation.metricsSummary.messagesProcessedTotal}** | Consumer fails: **${correlation.metricsSummary.consumerFailuresTotal}** | Redeliveries: **${correlation.metricsSummary.messageRedeliveriesTotal}**`,
        `- Recuperação observada: mín **${correlation.recoveryDuration.min}ms** / máx **${correlation.recoveryDuration.max}ms** / média **${correlation.recoveryDuration.avg}ms**`,
        `- Riscos exercitados: ${correlation.exercisedRisks.map((r) => `\`${r}\``).join(', ') || '_nenhum_'}`,
        `- Controles exercitados: ${correlation.exercisedControls.map((c) => `\`${c}\``).join(', ') || '_nenhum_'}`,
        `- Falhas/anomalias registradas: ${correlation.observedFailures.map((f) => `\`${f}\``).join(', ') || '_nenhuma_'}`,
        '',
      ]
    : [];

  return [
    '## QE Intelligence Layer — Telemetry & Trace Intelligence (AI-03)',
    '',
    '> [LAB] Análise consultiva de telemetria distribuída, rastros e métricas. Decisão de qualidade permanece humana.',
    '',
    `- Confiança da IA: **${advisory.confidence}**`,
    `- Provedor: \`${outcome.provider}\` (Modelo: \`${outcome.model}\`, Prompt: \`${QE_TELEMETRY_PROMPT_VERSION}\`)`,
    '',
    ...metricsSection,
    '### Resumo executivo de telemetria',
    '',
    advisory.executiveSummary,
    '',
    ...formatItems('Pontos prováveis de degradação', advisory.probableDegradationPoints),
    ...formatItems('Riscos de qualidade impactados', advisory.affectedRisks),
    ...formatItems('Achados de traces e spans', advisory.traceFindings),
    ...formatItems('Achados de métricas', advisory.metricFindings),
    ...formatItems('Gaps de instrumentação e observabilidade', advisory.instrumentationGaps),
    ...formatItems('Preocupações de consistência', advisory.consistencyConcerns),
    ...formatItems('Investigações recomendadas', advisory.recommendedInvestigations),
    ...formatItems('Testes adicionais recomendados', advisory.recommendedTests),
    ...formatItems('Perguntas para revisão humana', advisory.humanQuestions),
  ].join('\n');
}

async function main(): Promise<void> {
  const provider = createOpenAiProvider();
  const context = buildTelemetryAdvisoryContext();
  const outcome = await runTelemetryAdvisoryAnalysis(provider, context);
  process.stdout.write(`${formatTelemetryAdvisorySummary(outcome, context.telemetryCorrelation)}\n`);
}

const executedFile = process.argv[1];
if (executedFile && import.meta.url === pathToFileURL(executedFile).href) {
  void main().catch(() => {
    process.stdout.write(`${formatTelemetryAdvisorySummary({
      status: AI_TELEMETRY_ADVISORY_UNAVAILABLE,
      reason: 'TIMEOUT_OR_PROVIDER_FAILURE',
    })}\n`);
  });
}
