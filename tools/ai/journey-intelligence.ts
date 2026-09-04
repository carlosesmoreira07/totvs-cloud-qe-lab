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
  loadJourneyData,
  type DeterministicJourneyCorrelation,
  type NormalizedJourneyEvidence,
} from './journey-evidence-loader.js';
import {
  aiJourneyAdvisorySchema,
  parseAiJourneyAdvisory,
  type AiJourneyAdvisory,
  type JourneyFindingItem,
} from './journey-schema.js';
import type { DeterministicTelemetryCorrelation } from './telemetry-evidence-loader.js';
import type { NormalizedResiliencyEvidence } from './evidence-loader.js';

export const AI_JOURNEY_ADVISORY_UNAVAILABLE = 'AI_JOURNEY_ADVISORY_UNAVAILABLE' as const;
export const QE_JOURNEY_PROMPT_VERSION = 'qe-journey-advisory-v1' as const;

export const JOURNEY_SYSTEM_INSTRUCTIONS = [
  'Você é uma camada consultiva de Journey Intelligence de Quality Engineering.',
  'Analise as evidências de jornadas sintéticas completas de ponta a ponta (LAB-08), correlações com telemetria (LAB-07), resiliência distribuída (LAB-06) e diff de código.',
  'REGRA RÍGIDA ANTI-ALUCINAÇÃO: Para CADA finding retornado em qualquer seção, defina obrigatoriamente o campo classification como um dos três valores exatos:',
  '- OBSERVED: evidência direta, mensurada e comprovável nos JSONs de jornada (latência, duração E2E, SLA, status, retries, redeliveries ou spans com erro);',
  '- INFERRED: hipótese fundamentada na correlação lógica de múltiplos sinais (ex: gargalo na recuperação da fronteira Publisher -> NATS);',
  '- GAP: ausência de evidência, histórico suficiente para baseline, ou cenário de teste faltante.',
  'VEDAÇÃO CATEGÓRICA DE JULGAMENTOS GENÉRICOS: Nunca afirme que "o sistema está performático" ou que "o sistema atende SLA de produção". Use exclusivamente formulações circunscritas como: "as N jornadas sintéticas executadas ficaram dentro dos limites [LAB] definidos".',
  'PROIBIÇÃO DE CAUSA RAIZ CATEGÓRICA: Nunca declare causa raiz definitiva sem prova matemática/determinística cabal.',
  'NÃO RECALCULE MÉTRICAS: Utilize estritamente os valores agregados e correlações determinísticas já fornecidos no contexto.',
  'Para cada finding, forneça subject, rationale concisa, cite a evidência específica (ex: nome da jornada, duração, traceId, métrica ou arquivo) e classifique corretamente.',
  'Não aprove nem reprove a release; sua análise é estritamente consultiva para o Quality Engineer humano.',
].join(' ');

export interface JourneyAdvisoryContext {
  purpose: 'journey-intelligence-advisory';
  promptVersion: typeof QE_JOURNEY_PROMPT_VERSION;
  guardrails: string[];
  changes: ImpactContext;
  controlResults: ControlResultsSummary;
  journeyCorrelation: DeterministicJourneyCorrelation;
  journeyEvidences: NormalizedJourneyEvidence[];
  telemetryCorrelation: DeterministicTelemetryCorrelation;
  resiliencyEvidences: NormalizedResiliencyEvidence[];
}

export type JourneyAdvisoryOutcome =
  | { status: 'AVAILABLE'; provider: string; model: string; advisory: AiJourneyAdvisory }
  | { status: typeof AI_JOURNEY_ADVISORY_UNAVAILABLE; reason: AiAdvisoryUnavailableReason };

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new AiProviderUnavailableError('TIMEOUT_OR_PROVIDER_FAILURE', 'Journey advisory timed out')),
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

export function buildJourneyAdvisoryContext(
  journeysDir?: string,
  observabilityDir?: string,
  resiliencyDir?: string,
  impactContextPath?: string,
  testResultsPath?: string,
): JourneyAdvisoryContext {
  const {
    journeyEvidences,
    resiliencyEvidences,
    telemetryCorrelation,
    correlation,
  } = loadJourneyData(
    journeysDir ?? process.env.QE_JOURNEY_DIR,
    observabilityDir ?? process.env.QE_OBSERVABILITY_DIR,
    resiliencyDir ?? process.env.QE_RESILIENCY_DIR,
  );
  const changes = readImpactContext(impactContextPath ?? process.env.QE_IMPACT_CONTEXT_PATH);
  const controlResults = readControlResults(testResultsPath ?? process.env.QE_TEST_RESULTS_PATH);

  return {
    purpose: 'journey-intelligence-advisory',
    promptVersion: QE_JOURNEY_PROMPT_VERSION,
    guardrails: [
      'differentiate-observed-inferred-gap',
      'no-unqualified-performance-claims',
      'no-unqualified-root-cause-claims',
      'evidence-citation-required',
      'strict-finding-classification',
      'recommendations-only',
      'no-release-decision',
      'human-review-required',
    ],
    changes,
    controlResults,
    journeyCorrelation: correlation,
    journeyEvidences,
    telemetryCorrelation,
    resiliencyEvidences,
  };
}

export async function runJourneyAdvisoryAnalysis(
  provider: AiProvider,
  context: JourneyAdvisoryContext,
  timeoutMs = DEFAULT_QE_AI_TIMEOUT_MS,
): Promise<JourneyAdvisoryOutcome> {
  try {
    const raw = await withTimeout(
      provider.analyze(context, {
        schema: aiJourneyAdvisorySchema,
        schemaName: 'qe_journey_advisory',
        instructions: JOURNEY_SYSTEM_INSTRUCTIONS,
        maxOutputTokens: 2_500,
      }),
      timeoutMs,
    );

    return {
      status: 'AVAILABLE',
      provider: provider.name,
      model: provider.model,
      advisory: parseAiJourneyAdvisory(raw),
    };
  } catch (error) {
    if (error instanceof AiProviderUnavailableError) {
      return { status: AI_JOURNEY_ADVISORY_UNAVAILABLE, reason: error.reason };
    }
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return { status: AI_JOURNEY_ADVISORY_UNAVAILABLE, reason: 'INVALID_RESPONSE' };
    }
    return { status: AI_JOURNEY_ADVISORY_UNAVAILABLE, reason: 'TIMEOUT_OR_PROVIDER_FAILURE' };
  }
}

function formatItems(title: string, items: JourneyFindingItem[]): string[] {
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

export function formatJourneyAdvisorySummary(
  outcome: JourneyAdvisoryOutcome,
  correlation?: DeterministicJourneyCorrelation,
): string {
  if (outcome.status === AI_JOURNEY_ADVISORY_UNAVAILABLE) {
    return [
      '## QE Intelligence Layer — Journey Intelligence (AI-04)',
      '',
      `**${AI_JOURNEY_ADVISORY_UNAVAILABLE}**`,
      '',
      'AI Journey Advisory indisponível — Quality Gate não afetado.',
      '',
      `Motivo técnico: \`${outcome.reason}\`.`,
      '',
    ].join('\n');
  }

  const { advisory } = outcome;
  const metricsSection = correlation
    ? [
        '### Correlação determinística de jornadas sintéticas',
        '',
        `- Total de jornadas: **${correlation.totalJourneys}** (Aprovadas: **${correlation.passedJourneys}**, Falhas: **${correlation.failedJourneys}**)`,
        `- Conformidade de SLA sintético: **${correlation.slaMetCount} MET** / **${correlation.slaBreachedCount} BREACHED**`,
        `- Latência da API (aceitação síncrona): mín **${correlation.apiLatency.min}ms** / máx **${correlation.apiLatency.max}ms** / média **${correlation.apiLatency.avg}ms**`,
        `- Duração E2E completa: mín **${correlation.endToEndDuration.min}ms** / máx **${correlation.endToEndDuration.max}ms** / média **${correlation.endToEndDuration.avg}ms**`,
        `- Duração de recuperação pós-falha: mín **${correlation.recoveryDuration.min}ms** / máx **${correlation.recoveryDuration.max}ms** / média **${correlation.recoveryDuration.avg}ms**`,
        `- Retentativas e reentregas: **${correlation.totalRetries} retries** de cliente / **${correlation.totalRedeliveries} redeliveries** de broker`,
        `- Jornada mais lenta: ${
          correlation.slowestJourney
            ? `\`${correlation.slowestJourney.journey}\` (**${correlation.slowestJourney.endToEndDurationMs}ms**)`
            : '_nenhuma_'
        }`,
        `- Riscos exercitados: ${correlation.exercisedRisks.map((r) => `\`${r}\``).join(', ') || '_nenhum_'}`,
        `- Controles exercitados: ${correlation.exercisedControls.map((c) => `\`${c}\``).join(', ') || '_nenhum_'}`,
        ...(correlation.trendFindings.length > 0
          ? [
              '- Variações e tendências observadas:',
              ...correlation.trendFindings.map((t) => `  - \`[${t.journey}]\` ${t.observation}`),
            ]
          : []),
        '',
      ]
    : [];

  return [
    '## QE Intelligence Layer — Journey Intelligence (AI-04)',
    '',
    '> [LAB] Análise consultiva de jornadas sintéticas de ponta a ponta e SLAs. Decisão de qualidade permanece humana.',
    '',
    `- Confiança da IA: **${advisory.confidence}**`,
    `- Provedor: \`${outcome.provider}\` (Modelo: \`${outcome.model}\`, Prompt: \`${QE_JOURNEY_PROMPT_VERSION}\`)`,
    '',
    ...metricsSection,
    '### Resumo executivo de jornadas',
    '',
    advisory.executiveSummary,
    '',
    ...formatItems('Jornadas degradadas', advisory.degradedJourneys),
    ...formatItems('Achados de SLA sintético', advisory.slaFindings),
    ...formatItems('Gargalos prováveis identificados', advisory.probableBottlenecks),
    ...formatItems('Riscos de qualidade impactados', advisory.affectedRisks),
    ...formatItems('Correlações com traces e spans', advisory.traceCorrelations),
    ...formatItems('Correlações com resiliência', advisory.resilienceCorrelations),
    ...formatItems('Gaps de cobertura', advisory.coverageGaps),
    ...formatItems('Investigações recomendadas', advisory.recommendedInvestigations),
    ...formatItems('Testes recomendados', advisory.recommendedTests),
    ...formatItems('Perguntas para revisão humana', advisory.humanQuestions),
  ].join('\n');
}

async function main(): Promise<void> {
  const provider = createOpenAiProvider();
  const context = buildJourneyAdvisoryContext();
  const outcome = await runJourneyAdvisoryAnalysis(provider, context);
  process.stdout.write(`${formatJourneyAdvisorySummary(outcome, context.journeyCorrelation)}\n`);
}

const executedFile = process.argv[1];
if (executedFile && import.meta.url === pathToFileURL(executedFile).href) {
  void main().catch(() => {
    process.stdout.write(`${formatJourneyAdvisorySummary({
      status: AI_JOURNEY_ADVISORY_UNAVAILABLE,
      reason: 'TIMEOUT_OR_PROVIDER_FAILURE',
    })}\n`);
  });
}
