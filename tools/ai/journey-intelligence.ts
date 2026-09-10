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
  'Escreva um executiveSummary conciso em exatamente 1 frase.',
  'Seja altamente seletivo: liste no máximo 1 a 2 itens mais relevantes nas seções prioritárias e deixe as demais como arrays vazios [] quando não houver anomalia.',
  'REGRA RÍGIDA ANTI-ALUCINAÇÃO: Para CADA finding retornado em qualquer seção, defina obrigatoriamente o campo classification como um dos três valores exatos: OBSERVED, INFERRED ou GAP.',
  'VEDAÇÃO CATEGÓRICA DE JULGAMENTOS GENÉRICOS: Nunca afirme que "o sistema está performático" ou que "o sistema atende SLA de produção".',
  'PROIBIÇÃO DE CAUSA RAIZ CATEGÓRICA: Nunca declare causa raiz definitiva sem prova matemática/determinística cabal.',
  'NÃO RECALCULE MÉTRICAS: Utilize estritamente os valores agregados e correlações determinísticas já fornecidos no contexto.',
  'Para cada finding, forneça subject curto, rationale concisa (1-2 frases), cite pelo menos 1 evidência específica no array evidence (nunca vazio) e classifique corretamente.',
  'No máximo 1 pergunta humana (humanQuestions) e apenas se indispensável; deixe [] se não houver dúvida.',
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
        maxOutputTokens: 1100,
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

function formatItems(title: string, items: JourneyFindingItem[], limit = 3): string[] {
  if (items.length === 0) return [];
  return [
    `**${title}:**`,
    ...items.slice(0, limit).map((item) => `- [${item.classification}] ${item.subject}: ${item.rationale}`),
    '',
  ];
}

export function formatJourneyAdvisorySummary(
  outcome: JourneyAdvisoryOutcome,
  correlation?: DeterministicJourneyCorrelation,
): string {
  if (outcome.status === AI_JOURNEY_ADVISORY_UNAVAILABLE) {
    return [
      '## Journey Intelligence (AI-04)',
      '',
      `**${AI_JOURNEY_ADVISORY_UNAVAILABLE}** — Quality Gate não afetado. \`${outcome.reason}\``,
      '',
      '`AI advisory · decisão humana`',
      '',
    ].join('\n');
  }

  const { advisory } = outcome;
  const impact = correlation && (correlation.failedJourneys > 0 || correlation.slaBreachedCount > 0) ? 'HIGH' : 'LOW';
  const lines: string[] = [
    '## Journey Intelligence (AI-04)',
    '',
    `**Resumo:** ${advisory.executiveSummary}`,
    `**Impacto:** ${impact} · Confiança: ${advisory.confidence}`,
    '',
  ];

  const risks = [
    ...advisory.degradedJourneys,
    ...advisory.slaFindings,
    ...advisory.probableBottlenecks,
  ];
  if (risks.length > 0) {
    lines.push(`**Risco:** [${risks[0]!.classification}] ${risks[0]!.subject}: ${risks[0]!.rationale}`, '');
  }

  const actions = [
    ...advisory.recommendedInvestigations,
    ...advisory.coverageGaps,
    ...advisory.recommendedTests,
  ].slice(0, 2);
  if (actions.length === 1) {
    lines.push(`**Ação:** [${actions[0]!.classification}] ${actions[0]!.subject}: ${actions[0]!.rationale}`, '');
  } else if (actions.length > 1) {
    lines.push('**Ação:**', ...actions.map((item) => `- [${item.classification}] ${item.subject}: ${item.rationale}`), '');
  }

  if (advisory.humanQuestions.length > 0) {
    lines.push(`**Pergunta:** ${advisory.humanQuestions[0]!.subject} — ${advisory.humanQuestions[0]!.rationale}`, '');
  }

  lines.push('`AI advisory · decisão humana`', '');
  return lines.join('\n');
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
