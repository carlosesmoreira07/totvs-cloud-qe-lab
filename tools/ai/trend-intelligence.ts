import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ZodError } from 'zod';

import {
  parseHistoryFile,
  parseTrendsFile,
  type DimensionTrendEvaluation,
  type HistoryFile,
  type HistorySnapshot,
  type TrendsFile,
} from '../history/history-schema.js';
import { parseExecutiveScorecard, type ExecutiveScorecard } from '../scorecard/scorecard-schema.js';
import { createOpenAiProvider, DEFAULT_QE_AI_TIMEOUT_MS } from './openai-provider.js';
import {
  AiProviderUnavailableError,
  type AiAdvisoryUnavailableReason,
  type AiProvider,
} from './provider.js';
import {
  aiTrendAdvisorySchema,
  parseAiTrendAdvisory,
  type AiTrendAdvisory,
  type TrendIntelligenceFinding,
} from './trend-intelligence-schema.js';

export const AI_TREND_ADVISORY_UNAVAILABLE = 'AI_TREND_ADVISORY_UNAVAILABLE' as const;
export const QE_TREND_PROMPT_VERSION = 'qe-trend-advisory-v1' as const;

export const TREND_SYSTEM_INSTRUCTIONS = [
  'Você é uma camada consultiva de Trend & Regression Intelligence para Quality Engineering e liderança técnica.',
  'O histórico e tendências determinísticas fornecidos são a fonte objetiva da verdade; NUNCA recalcule tendências ou indicadores.',
  'Escreva um executiveSummary conciso em exatamente 1 frase.',
  'Seja altamente seletivo: aponte no máximo 1 a 2 itens materiais nas seções prioritárias e deixe as demais como arrays vazios [] quando não houver anomalia.',
  'Classifique cada item como OBSERVED, INFERRED ou GAP, com rationale concisa (1-2 frases) e cite pelo menos 1 evidência no array evidence.',
  'Se historicalTrend for UNKNOWN ou houver menos de 3 checkpoints, você DEVE explicitamente respeitar essa condição e declarar que o histórico é insuficiente para concluir tendência na respectiva dimensão.',
  'Não invente métricas, SLAs, causas raiz ou impactos de produção da TOTVS.',
  'Nunca afirme que "a qualidade geral melhorou definitivamente", que "o sistema está saudável", que "o sistema está seguro" ou que uma "release está aprovada".',
  'No máximo 1 pergunta humana (humanQuestions) e apenas se indispensável; deixe [] se não houver dúvida.',
  'Recomende investigações humanas e ações preventivas; não altere código, testes, riscos, gates ou decisões de release.',
].join(' ');

export interface DimensionTrendSummary {
  dimension: string;
  label: string;
  historicalTrend: string;
  comparisonStatus: string;
  latestStatus: string;
  interpretation: string;
  dataPointsCount: number;
}

export interface MetricDelta {
  metric: string;
  firstValue: string | number;
  latestValue: string | number;
  delta: string;
  direction: 'IMPROVED' | 'DEGRADED' | 'STABLE' | 'UNKNOWN';
}

export interface LatencyEvolutionPoint {
  commit: string;
  timestamp: string;
  p95Ms: number | null;
  p99Ms: number | null;
}

export interface SlaEvolutionPoint {
  commit: string;
  timestamp: string;
  slaMet: number;
  slaBreached: number;
  totalJourneys: number;
}

export interface TrendAdvisoryContext {
  purpose: 'trend-and-regression-intelligence';
  promptVersion: typeof QE_TREND_PROMPT_VERSION;
  guardrails: string[];
  checkpointsCount: number;
  canCalculateTrend: boolean;
  overallHistoricalTrend: string;
  overallComparisonStatus: string;
  trendDisclaimer: string;
  dimensions: DimensionTrendSummary[];
  improvingMetrics: MetricDelta[];
  degradingMetrics: MetricDelta[];
  newRisks: string[];
  resolvedRisks: string[];
  newGaps: string[];
  persistentGaps: string[];
  regressionsDetected: string[];
  securityFindingsBySeverity: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
  };
  p95Evolution: LatencyEvolutionPoint[];
  p99Evolution: LatencyEvolutionPoint[];
  slaEvolution: SlaEvolutionPoint[];
  latestCommit: string;
  firstCommit: string;
}

export type TrendAdvisoryOutcome =
  | { status: 'AVAILABLE'; provider: string; model: string; advisory: AiTrendAdvisory }
  | { status: typeof AI_TREND_ADVISORY_UNAVAILABLE; reason: AiAdvisoryUnavailableReason };

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new AiProviderUnavailableError('TIMEOUT_OR_PROVIDER_FAILURE', 'Trend advisory timed out')),
      timeoutMs,
    );
    operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

export interface BuildTrendContextOptions {
  repositoryRoot?: string;
  historyPath?: string;
  trendsPath?: string;
  scorecardPath?: string;
}

export function buildTrendAdvisoryContext(options: BuildTrendContextOptions = {}): TrendAdvisoryContext {
  const repoRoot = options.repositoryRoot ?? process.cwd();
  const historyPath = options.historyPath ?? path.join(repoRoot, 'evidence', 'history', 'history.json');
  const trendsPath = options.trendsPath ?? path.join(repoRoot, 'evidence', 'history', 'trends.json');
  const scorecardPath = options.scorecardPath ?? path.join(repoRoot, 'evidence', 'scorecard', 'current.json');

  let history: HistoryFile | null = null;
  let trends: TrendsFile | null = null;
  let scorecard: ExecutiveScorecard | null = null;

  try {
    if (fs.existsSync(historyPath)) {
      history = parseHistoryFile(JSON.parse(fs.readFileSync(historyPath, 'utf8')));
    }
  } catch {
    history = null;
  }

  try {
    if (fs.existsSync(trendsPath)) {
      trends = parseTrendsFile(JSON.parse(fs.readFileSync(trendsPath, 'utf8')));
    }
  } catch {
    trends = null;
  }

  try {
    if (fs.existsSync(scorecardPath)) {
      scorecard = parseExecutiveScorecard(JSON.parse(fs.readFileSync(scorecardPath, 'utf8')));
    }
  } catch {
    scorecard = null;
  }

  const snapshots = history?.snapshots ?? [];
  const sortedSnapshots = [...snapshots].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const checkpointsCount = sortedSnapshots.length;
  const firstSnapshot: HistorySnapshot | undefined = sortedSnapshots[0];
  const latestSnapshot: HistorySnapshot | undefined = sortedSnapshots[checkpointsCount - 1];

  const canCalculateTrend = trends?.canCalculateTrend ?? (checkpointsCount >= 3);
  const overallHistoricalTrend = trends?.overallTrend ?? 'UNKNOWN';
  const overallComparisonStatus = trends?.comparisonStatus ?? 'UNKNOWN';
  const trendDisclaimer = trends?.disclaimer ?? (
    checkpointsCount < 3
      ? `Histórico insuficiente: ${checkpointsCount} checkpoint(s). Mínimo de 3 checkpoints para cálculo de tendência histórica.`
      : 'Tendência calculada sobre série histórica de checkpoints.'
  );

  const dimensions: DimensionTrendSummary[] = trends?.dimensions.map((d: DimensionTrendEvaluation) => ({
    dimension: d.dimension,
    label: d.label,
    historicalTrend: d.historicalTrend,
    comparisonStatus: d.comparisonStatus,
    latestStatus: d.latestStatus,
    interpretation: d.interpretation,
    dataPointsCount: d.dataPoints.length,
  })) ?? [];

  const improvingMetrics: MetricDelta[] = [];
  const degradingMetrics: MetricDelta[] = [];

  if (firstSnapshot && latestSnapshot && checkpointsCount >= 2) {
    // 1. Risk coverage
    const covDelta = latestSnapshot.riskCoverage.coveragePct - firstSnapshot.riskCoverage.coveragePct;
    if (covDelta > 0.5) {
      improvingMetrics.push({
        metric: 'Cobertura de riscos (%)',
        firstValue: `${firstSnapshot.riskCoverage.coveragePct}%`,
        latestValue: `${latestSnapshot.riskCoverage.coveragePct}%`,
        delta: `+${covDelta.toFixed(1)}%`,
        direction: 'IMPROVED',
      });
    } else if (covDelta < -0.5) {
      degradingMetrics.push({
        metric: 'Cobertura de riscos (%)',
        firstValue: `${firstSnapshot.riskCoverage.coveragePct}%`,
        latestValue: `${latestSnapshot.riskCoverage.coveragePct}%`,
        delta: `${covDelta.toFixed(1)}%`,
        direction: 'DEGRADED',
      });
    }

    // 2. Controls passed
    const ctrlPassedDelta = latestSnapshot.controlsPassed - firstSnapshot.controlsPassed;
    if (ctrlPassedDelta > 0) {
      improvingMetrics.push({
        metric: 'Controles aprovados',
        firstValue: firstSnapshot.controlsPassed,
        latestValue: latestSnapshot.controlsPassed,
        delta: `+${ctrlPassedDelta}`,
        direction: 'IMPROVED',
      });
    }

    // 3. Controls failed
    if (latestSnapshot.controlsFailed > firstSnapshot.controlsFailed) {
      degradingMetrics.push({
        metric: 'Controles com falha',
        firstValue: firstSnapshot.controlsFailed,
        latestValue: latestSnapshot.controlsFailed,
        delta: `+${latestSnapshot.controlsFailed - firstSnapshot.controlsFailed}`,
        direction: 'DEGRADED',
      });
    }

    // 4. Performance p95
    if (firstSnapshot.apiP95 !== null && latestSnapshot.apiP95 !== null && firstSnapshot.apiP95 > 0) {
      const p95Ratio = (latestSnapshot.apiP95 - firstSnapshot.apiP95) / firstSnapshot.apiP95;
      if (p95Ratio > 0.10) {
        degradingMetrics.push({
          metric: 'Latência p95 da API (ms)',
          firstValue: `${firstSnapshot.apiP95} ms`,
          latestValue: `${latestSnapshot.apiP95} ms`,
          delta: `+${Math.round(p95Ratio * 100)}%`,
          direction: 'DEGRADED',
        });
      } else if (p95Ratio < -0.10) {
        improvingMetrics.push({
          metric: 'Latência p95 da API (ms)',
          firstValue: `${firstSnapshot.apiP95} ms`,
          latestValue: `${latestSnapshot.apiP95} ms`,
          delta: `${Math.round(p95Ratio * 100)}%`,
          direction: 'IMPROVED',
        });
      }
    }

    // 5. Gaps
    const gapsDelta = latestSnapshot.knownGaps.length - firstSnapshot.knownGaps.length;
    if (gapsDelta < 0) {
      improvingMetrics.push({
        metric: 'Lacunas conhecidas (gaps)',
        firstValue: firstSnapshot.knownGaps.length,
        latestValue: latestSnapshot.knownGaps.length,
        delta: `${gapsDelta}`,
        direction: 'IMPROVED',
      });
    } else if (gapsDelta > 0) {
      degradingMetrics.push({
        metric: 'Lacunas conhecidas (gaps)',
        firstValue: firstSnapshot.knownGaps.length,
        latestValue: latestSnapshot.knownGaps.length,
        delta: `+${gapsDelta}`,
        direction: 'DEGRADED',
      });
    }

    // 6. Security Critical & High
    const firstCritHigh = firstSnapshot.securityFindings.critical + firstSnapshot.securityFindings.high;
    const latestCritHigh = latestSnapshot.securityFindings.critical + latestSnapshot.securityFindings.high;
    if (latestCritHigh > firstCritHigh) {
      degradingMetrics.push({
        metric: 'Achados de segurança Critical/High',
        firstValue: firstCritHigh,
        latestValue: latestCritHigh,
        delta: `+${latestCritHigh - firstCritHigh}`,
        direction: 'DEGRADED',
      });
    }
  }

  // Riscos novos e resolvidos
  const newRisks: string[] = [];
  const resolvedRisks: string[] = [];
  if (firstSnapshot && latestSnapshot) {
    if (latestSnapshot.riskCoverage.exercisedRisks > firstSnapshot.riskCoverage.exercisedRisks) {
      resolvedRisks.push(
        `${latestSnapshot.riskCoverage.exercisedRisks - firstSnapshot.riskCoverage.exercisedRisks} novos riscos receberam controles executados (total: ${latestSnapshot.riskCoverage.exercisedRisks}/${latestSnapshot.riskCoverage.knownRisks})`
      );
    }
  }

  // Gaps novos e persistentes
  const persistentGaps: string[] = [];
  const newGaps: string[] = [];
  if (latestSnapshot) {
    for (const gap of latestSnapshot.knownGaps) {
      if (firstSnapshot && firstSnapshot.knownGaps.includes(gap)) {
        persistentGaps.push(gap);
      } else {
        newGaps.push(gap);
      }
    }
  }

  // Regressões detectadas
  const regressionsDetected: string[] = [];
  if (latestSnapshot?.regressionStatus === 'RED') {
    regressionsDetected.push('Regressão detectada contra o baseline de performance.');
  }
  if (scorecard?.summary && scorecard.summary.controlsFailed > 0) {
    regressionsDetected.push(`${scorecard.summary.controlsFailed} controle(s) com falha no scorecard atual.`);
  }

  // Security findings
  const securityFindingsBySeverity = latestSnapshot?.securityFindings ?? {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };

  // Evolution series
  const p95Evolution: LatencyEvolutionPoint[] = sortedSnapshots.map((s) => ({
    commit: s.commitSha,
    timestamp: s.timestamp,
    p95Ms: s.apiP95,
    p99Ms: s.apiP99,
  }));

  const p99Evolution: LatencyEvolutionPoint[] = p95Evolution;

  const slaEvolution: SlaEvolutionPoint[] = sortedSnapshots.map((s) => ({
    commit: s.commitSha,
    timestamp: s.timestamp,
    slaMet: s.slaMet,
    slaBreached: s.slaBreached,
    totalJourneys: s.journeysPassed + s.journeysFailed,
  }));

  return {
    purpose: 'trend-and-regression-intelligence',
    promptVersion: QE_TREND_PROMPT_VERSION,
    guardrails: [
      'Não recalcule tendências ou métricas.',
      'Não use expressões proibidas de aprovação de release ou declaração de sistema saudável/seguro.',
      'Classifique cada finding como OBSERVED, INFERRED ou GAP com evidências concretas.',
      'Respeite histórico insuficiente e trend UNKNOWN.',
      'A decisão permanece estritamente humana.',
    ],
    checkpointsCount,
    canCalculateTrend,
    overallHistoricalTrend,
    overallComparisonStatus,
    trendDisclaimer,
    dimensions,
    improvingMetrics,
    degradingMetrics,
    newRisks,
    resolvedRisks,
    newGaps,
    persistentGaps,
    regressionsDetected,
    securityFindingsBySeverity,
    p95Evolution,
    p99Evolution,
    slaEvolution,
    latestCommit: latestSnapshot?.commitSha ?? 'unknown',
    firstCommit: firstSnapshot?.commitSha ?? 'unknown',
  };
}

export async function runTrendAdvisoryAnalysis(
  provider: AiProvider,
  context: TrendAdvisoryContext,
  timeoutMs = DEFAULT_QE_AI_TIMEOUT_MS,
): Promise<TrendAdvisoryOutcome> {
  try {
    const raw = await withTimeout(provider.analyze(context, {
      schema: aiTrendAdvisorySchema,
      schemaName: 'qe_trend_advisory',
      instructions: TREND_SYSTEM_INSTRUCTIONS,
      maxOutputTokens: 1200,
    }), timeoutMs);

    const validatedAdvisory = parseAiTrendAdvisory(raw);
    return {
      status: 'AVAILABLE',
      provider: provider.name,
      model: provider.model,
      advisory: validatedAdvisory,
    };
  } catch (error) {
    if (error instanceof AiProviderUnavailableError) {
      return {
        status: AI_TREND_ADVISORY_UNAVAILABLE,
        reason: error.reason,
      };
    }
    if (error instanceof SyntaxError || error instanceof ZodError) {
      return {
        status: AI_TREND_ADVISORY_UNAVAILABLE,
        reason: 'INVALID_RESPONSE',
      };
    }
    return {
      status: AI_TREND_ADVISORY_UNAVAILABLE,
      reason: 'TIMEOUT_OR_PROVIDER_FAILURE',
    };
  }
}

function renderFindingsSection(title: string, findings: TrendIntelligenceFinding[], limit = 3): string[] {
  if (findings.length === 0) return [];
  const lines: string[] = [`**${title}:**`, ''];
  for (const f of findings.slice(0, limit)) {
    lines.push(`- [${f.classification}] **${f.subject}**: ${f.rationale}`);
  }
  lines.push('');
  return lines;
}

export function formatTrendAdvisoryMarkdown(outcome: TrendAdvisoryOutcome): string {
  if (outcome.status === AI_TREND_ADVISORY_UNAVAILABLE) {
    return [
      '## Tendências e Regressões (AI-07)',
      '',
      `**${AI_TREND_ADVISORY_UNAVAILABLE}** — Quality Gate não afetado. \`${outcome.reason}\``,
      '',
      '`AI advisory · decisão humana`',
      '',
    ].join('\n');
  }

  const advisory = outcome.advisory;
  const impact = (advisory.degradingAreas.length > 0 || advisory.regressionFindings.length > 0) ? 'DEGRADING' : 'STABLE';
  const lines: string[] = [
    '## Tendências e Regressões (AI-07)',
    '',
    `**Resumo:** ${advisory.executiveSummary}`,
    `**Impacto:** ${impact} · Confiança: ${advisory.confidence}`,
    '',
  ];

  const risks = [
    ...advisory.degradingAreas,
    ...advisory.regressionFindings,
    ...advisory.persistentRisks,
  ];
  if (risks.length > 0) {
    lines.push(`**Risco:** [${risks[0]!.classification}] ${risks[0]!.subject}: ${risks[0]!.rationale}`, '');
  }

  const actions = [
    ...advisory.recommendedActions,
    ...advisory.recommendedInvestigations,
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
  const scorecardDir = path.resolve(process.cwd(), 'evidence', 'scorecard');
  try {
    const context = buildTrendAdvisoryContext();
    const outcome = await runTrendAdvisoryAnalysis(createOpenAiProvider(), context);
    const markdown = formatTrendAdvisoryMarkdown(outcome);
    process.stdout.write(`${markdown}\n`);
    if (fs.existsSync(scorecardDir)) {
      fs.writeFileSync(path.join(scorecardDir, 'ai-trend-advisory.md'), markdown, 'utf8');
    }
  } catch {
    const fallbackMarkdown = formatTrendAdvisoryMarkdown({
      status: AI_TREND_ADVISORY_UNAVAILABLE,
      reason: 'INVALID_RESPONSE',
    });
    process.stdout.write(`${fallbackMarkdown}\n`);
    if (fs.existsSync(scorecardDir)) {
      fs.writeFileSync(path.join(scorecardDir, 'ai-trend-advisory.md'), fallbackMarkdown, 'utf8');
    }
  }
}

const executedFile = process.argv[1];
if (executedFile && import.meta.url === pathToFileURL(executedFile).href) {
  void main();
}
