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
  'Escreva um executiveSummary conciso em exatamente 1 frase.',
  'Seja altamente seletivo: liste no máximo 1 a 2 itens mais relevantes nas seções prioritárias e deixe as demais como arrays vazios [] quando não houver apontamento material.',
  'REGRA RÍGIDA ANTI-ALUCINAÇÃO: Para CADA item retornado em qualquer seção, defina obrigatoriamente o campo classification como um dos três valores exatos:',
  '- OBSERVED: evidência ou anomalia diretamente presente e comprovável nos spans, atributos, status ERROR ou contadores de métricas;',
  '- INFERRED: hipótese fundamentada na correlação lógica de múltiplos sinais observados (ex: provável ponto de degradação na fronteira de comunicação);',
  '- GAP: ausência de evidência, métrica, span ou cobertura de instrumentação.',
  'PROIBIÇÃO DE CAUSA RAIZ CATEGÓRICA: Nunca afirme que um componente ou serviço foi a "causa raiz definitiva" sem prova matemática/determinística direta.',
  'Para cada finding, forneça subject curto, rationale concisa (1-2 frases), cite pelo menos 1 evidência específica no array evidence (nunca vazio) e classifique corretamente.',
  'No máximo 1 pergunta humana (humanQuestions) e apenas se indispensável; deixe [] se não houver dúvida.',
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
        maxOutputTokens: 1100,
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

function formatItems(title: string, items: TelemetryFindingItem[], limit = 3): string[] {
  if (items.length === 0) return [];
  return [
    `**${title}:**`,
    ...items.slice(0, limit).map((item) => {
      const badge = `[${item.classification}]`;
      return `- ${badge} ${item.subject}: ${item.rationale}`;
    }),
    '',
  ];
}

export function formatTelemetryAdvisorySummary(
  outcome: TelemetryAdvisoryOutcome,
  correlation?: DeterministicTelemetryCorrelation,
): string {
  if (outcome.status === AI_TELEMETRY_ADVISORY_UNAVAILABLE) {
    return [
      '## Telemetry Intelligence (AI-03)',
      '',
      `**${AI_TELEMETRY_ADVISORY_UNAVAILABLE}** — Quality Gate não afetado. \`${outcome.reason}\``,
      '',
      '`AI advisory · decisão humana`',
      '',
    ].join('\n');
  }

  const { advisory } = outcome;
  const impact = correlation && (correlation.errorTraces.length > 0 || correlation.missingSpans.length > 0) ? 'HIGH' : 'LOW';
  const lines: string[] = [
    '## Telemetry Intelligence (AI-03)',
    '',
    `**Resumo:** ${advisory.executiveSummary}`,
    `**Impacto:** ${impact} · Confiança: ${advisory.confidence}`,
    '',
  ];

  const risks = [
    ...advisory.probableDegradationPoints,
    ...advisory.consistencyConcerns,
    ...advisory.traceFindings,
  ];
  if (risks.length > 0) {
    lines.push(`**Risco:** [${risks[0]!.classification}] ${risks[0]!.subject}: ${risks[0]!.rationale}`, '');
  }

  const actions = [
    ...advisory.recommendedInvestigations,
    ...advisory.instrumentationGaps,
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
