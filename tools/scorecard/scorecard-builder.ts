import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadResiliencyData } from '../ai/evidence-loader.js';
import { loadJourneyData } from '../ai/journey-evidence-loader.js';
import { loadTelemetryData } from '../ai/telemetry-evidence-loader.js';
import { renderScorecardPdf } from './scorecard-pdf.js';
import { renderExecutiveSummaryMarkdown, renderScorecardHtml } from './scorecard-renderer.js';
import {
  parseExecutiveScorecard,
  type ExecutiveScorecard,
  type QualityStatus,
  type QualityTrend,
  type ScorecardDimension,
} from './scorecard-schema.js';

export interface RiskControlSignal {
  riskId: string;
  controlId: string;
}

export interface ControlExecutionSignal extends RiskControlSignal {
  result: 'PASSED' | 'FAILED';
  source: string;
  kind: 'RESILIENCY' | 'OBSERVABILITY' | 'JOURNEY' | 'PERFORMANCE';
}

export interface ScorecardSignals {
  riskControls: RiskControlSignal[];
  controlExecutions: ControlExecutionSignal[];
  invalidEvidenceFiles: number;
  sources: {
    riskMap: boolean;
    resiliency: boolean;
    observability: boolean;
    journeys: boolean;
    performanceCurrent: boolean;
    performanceBaseline: boolean;
  };
  journeys: {
    total: number;
    passed: number;
    failed: number;
    slaMet: number;
    slaBreached: number;
    apiLatencyMaxMs: number;
    endToEndMaxMs: number;
  };
  resilience: {
    total: number;
    passed: number;
    failed: number;
    recoveryMinMs: number;
    recoveryAvgMs: number;
    recoveryMaxMs: number;
  };
  observability: {
    total: number;
    passed: number;
    failed: number;
    traces: number;
    errorTraces: number;
    missingSpanScenarios: number;
  };
  performance: {
    result: 'PASSED' | 'FAILED' | 'UNKNOWN';
    p50Ms: number | null;
    p95Ms: number | null;
    p99Ms: number | null;
    throughputRps: number | null;
    errorRate: number | null;
    duplicateResources: number | null;
    duplicateOperations: number | null;
    e2eP95Ms: number | null;
    thresholdStatus: 'MET' | 'BREACHED' | 'UNKNOWN';
    comparisonStatus: 'IMPROVED' | 'STABLE' | 'REGRESSED' | 'NO_BASELINE';
    tolerancePct: number | null;
    regressedMetrics: string[];
  };
  hasHistoricalSeries: boolean;
  latestEvidenceAt: string | null;
}

interface BuildMetadata {
  generatedAt?: string;
  commit?: string;
}

interface PerformanceCurrent {
  startedAt?: string;
  completedAt?: string;
  throughput?: number;
  errorRate?: number;
  latency?: { p50?: number; p95?: number; p99?: number };
  e2eLatency?: { p95?: number };
  duplicates?: { duplicateResources?: number; duplicateOperations?: number };
  thresholds?: {
    p95Met?: boolean;
    p99Met?: boolean;
    errorRateMet?: boolean;
    duplicatesMet?: boolean;
    e2eP95Met?: boolean;
    status?: string;
  };
  baselineComparison?: {
    status?: string;
    tolerancePct?: number;
    regressedMetrics?: string[];
  };
  result?: string;
}

const PERFORMANCE_CONTROLS: RiskControlSignal[] = [
  { riskId: 'RISK-PERF-001', controlId: 'CTRL-PERF-LATENCY-001' },
  { riskId: 'RISK-PERF-002', controlId: 'CTRL-PERF-ERROR-RATE-001' },
  { riskId: 'RISK-PERF-003', controlId: 'CTRL-PERF-IDEMPOTENCY-CONCURRENCY-001' },
  { riskId: 'RISK-PERF-004', controlId: 'CTRL-PERF-E2E-THROUGHPUT-001' },
  { riskId: 'RISK-PERF-005', controlId: 'CTRL-PERF-BASELINE-REGRESSION-001' },
];

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseRiskMap(filePath: string): RiskControlSignal[] {
  try {
    return fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => /^\| `RISK-[^|]+\|/.test(line))
      .flatMap((line) => {
        const cells = line.split('|').slice(1, -1).map((cell) => cell.trim().replaceAll('`', ''));
        const riskId = cells[0];
        const controlId = cells[2];
        return riskId && controlId ? [{ riskId, controlId }] : [];
      });
  } catch {
    return [];
  }
}

function performanceExecutions(current: PerformanceCurrent | null): ControlExecutionSignal[] {
  if (!current) return [];
  const checks = [
    current.thresholds?.p95Met === true && current.thresholds?.p99Met === true,
    current.thresholds?.errorRateMet === true,
    current.thresholds?.duplicatesMet === true,
    current.thresholds?.e2eP95Met === true,
    current.baselineComparison?.status === 'IMPROVED' || current.baselineComparison?.status === 'STABLE',
  ];
  return PERFORMANCE_CONTROLS.map((control, index) => ({
    ...control,
    result: checks[index] ? 'PASSED' : 'FAILED',
    source: 'evidence/performance/current.json',
    kind: 'PERFORMANCE',
  }));
}

function latestIso(values: Array<string | undefined>): string | null {
  const timestamps = values
    .filter((value): value is string => Boolean(value) && Number.isFinite(Date.parse(value!)))
    .sort((left, right) => Date.parse(right) - Date.parse(left));
  return timestamps[0] ?? null;
}

export function loadScorecardSignals(repositoryRoot = process.cwd()): ScorecardSignals {
  const riskMapPath = path.join(repositoryRoot, 'docs', '04-quality-risk-map.md');
  const resiliencyDir = path.join(repositoryRoot, 'evidence', 'resiliency');
  const observabilityDir = path.join(repositoryRoot, 'evidence', 'observability');
  const journeysDir = path.join(repositoryRoot, 'evidence', 'journeys');
  const performanceDir = path.join(repositoryRoot, 'evidence', 'performance');
  const currentPath = path.join(performanceDir, 'current.json');
  const baselinePath = path.join(performanceDir, 'baseline.json');

  const resiliency = loadResiliencyData(resiliencyDir);
  const telemetry = loadTelemetryData(observabilityDir, resiliencyDir);
  const journey = loadJourneyData(journeysDir, observabilityDir, resiliencyDir);
  const current = readJson<PerformanceCurrent>(currentPath);
  const baseline = readJson<Record<string, unknown>>(baselinePath);

  const controlExecutions: ControlExecutionSignal[] = [
    ...resiliency.evidences.map((item) => ({
      riskId: item.riskId,
      controlId: item.controlId,
      result: item.result,
      source: `evidence/resiliency/${item.scenario}.json`,
      kind: 'RESILIENCY' as const,
    })),
    ...telemetry.observabilityEvidences.map((item) => ({
      riskId: item.riskId,
      controlId: item.controlId,
      result: item.result,
      source: `evidence/observability/${item.scenario}.json`,
      kind: 'OBSERVABILITY' as const,
    })),
    ...journey.journeyEvidences.map((item) => ({
      riskId: item.riskId,
      controlId: item.controlId,
      result: item.result,
      source: `evidence/journeys/${item.journey}.json`,
      kind: 'JOURNEY' as const,
    })),
    ...performanceExecutions(current),
  ];

  const comparisonStatus = current?.baselineComparison?.status;
  const normalizedComparison = comparisonStatus === 'IMPROVED' || comparisonStatus === 'STABLE' || comparisonStatus === 'REGRESSED'
    ? comparisonStatus
    : 'NO_BASELINE';
  const performanceResult = current?.result === 'PASSED' || current?.result === 'FAILED' ? current.result : 'UNKNOWN';
  const thresholdStatus = current?.thresholds?.status === 'MET'
    ? 'MET'
    : current?.thresholds?.status === 'BREACHED' ? 'BREACHED' : 'UNKNOWN';

  return {
    riskControls: parseRiskMap(riskMapPath),
    controlExecutions,
    invalidEvidenceFiles: resiliency.invalidFileCount + telemetry.invalidFileCount + journey.invalidFileCount,
    sources: {
      riskMap: fs.existsSync(riskMapPath),
      resiliency: fs.existsSync(resiliencyDir) && resiliency.evidences.length > 0,
      observability: fs.existsSync(observabilityDir) && telemetry.observabilityEvidences.length > 0,
      journeys: fs.existsSync(journeysDir) && journey.journeyEvidences.length > 0,
      performanceCurrent: current !== null,
      performanceBaseline: baseline !== null,
    },
    journeys: {
      total: journey.correlation.totalJourneys,
      passed: journey.correlation.passedJourneys,
      failed: journey.correlation.failedJourneys,
      slaMet: journey.correlation.slaMetCount,
      slaBreached: journey.correlation.slaBreachedCount,
      apiLatencyMaxMs: journey.correlation.apiLatency.max,
      endToEndMaxMs: journey.correlation.endToEndDuration.max,
    },
    resilience: {
      total: resiliency.metrics.totalScenarios,
      passed: resiliency.metrics.passed,
      failed: resiliency.metrics.failed,
      recoveryMinMs: resiliency.metrics.durationMs.min,
      recoveryAvgMs: resiliency.metrics.durationMs.avg,
      recoveryMaxMs: resiliency.metrics.durationMs.max,
    },
    observability: {
      total: telemetry.correlation.totalObservabilityScenarios,
      passed: telemetry.observabilityEvidences.filter((item) => item.result === 'PASSED').length,
      failed: telemetry.observabilityEvidences.filter((item) => item.result === 'FAILED').length,
      traces: telemetry.correlation.totalTraces,
      errorTraces: telemetry.correlation.errorTraces.length,
      missingSpanScenarios: telemetry.correlation.missingSpans.length,
    },
    performance: {
      result: performanceResult,
      p50Ms: numberOrNull(current?.latency?.p50),
      p95Ms: numberOrNull(current?.latency?.p95),
      p99Ms: numberOrNull(current?.latency?.p99),
      throughputRps: numberOrNull(current?.throughput),
      errorRate: numberOrNull(current?.errorRate),
      duplicateResources: numberOrNull(current?.duplicates?.duplicateResources),
      duplicateOperations: numberOrNull(current?.duplicates?.duplicateOperations),
      e2eP95Ms: numberOrNull(current?.e2eLatency?.p95),
      thresholdStatus,
      comparisonStatus: normalizedComparison,
      tolerancePct: numberOrNull(current?.baselineComparison?.tolerancePct),
      regressedMetrics: Array.isArray(current?.baselineComparison?.regressedMetrics)
        ? current.baselineComparison.regressedMetrics.filter((item): item is string => typeof item === 'string')
        : [],
    },
    hasHistoricalSeries: false,
    latestEvidenceAt: latestIso([
      ...resiliency.evidences.flatMap((item) => [item.startedAt, item.recoveredAt]),
      ...journey.journeyEvidences.flatMap((item) => [item.startedAt, item.completedAt]),
      current?.startedAt,
      current?.completedAt,
    ]),
  };
}

function executionStatus(total: number, failed: number): QualityStatus {
  if (total === 0) return 'UNKNOWN';
  return failed > 0 ? 'RED' : 'GREEN';
}

function indicator(key: string, label: string, value: string | number, status: QualityStatus, unit?: string) {
  return { key, label, value, status, ...(unit ? { unit } : {}) };
}

function evidence(source: string, kind: 'RISK_MAP' | 'RESILIENCY' | 'OBSERVABILITY' | 'JOURNEY' | 'PERFORMANCE' | 'BASELINE', result: string) {
  return { source, kind, result };
}

function overallStatus(dimensions: ScorecardDimension[]): QualityStatus {
  const operational = dimensions.filter((dimension) => ['CRITICAL_JOURNEYS', 'RESILIENCE', 'OBSERVABILITY', 'PERFORMANCE'].includes(dimension.key));
  if (operational.every((dimension) => dimension.status === 'UNKNOWN')) return 'UNKNOWN';
  if (dimensions.some((dimension) => dimension.status === 'RED')) return 'RED';
  if (dimensions.some((dimension) => dimension.status === 'YELLOW' || dimension.status === 'UNKNOWN')) return 'YELLOW';
  return 'GREEN';
}

function comparisonTrend(status: ScorecardSignals['performance']['comparisonStatus']): QualityTrend {
  if (status === 'IMPROVED') return 'IMPROVING';
  if (status === 'STABLE') return 'STABLE';
  if (status === 'REGRESSED') return 'DEGRADING';
  return 'UNKNOWN';
}

export function buildExecutiveScorecard(signals: ScorecardSignals, metadata: BuildMetadata = {}): ExecutiveScorecard {
  const knownRisks = signals.riskControls.length;
  const knownRiskIds = new Set(signals.riskControls.map((item) => item.riskId));
  const uniqueExecutions = new Map<string, ControlExecutionSignal>();
  for (const execution of signals.controlExecutions) uniqueExecutions.set(execution.controlId, execution);
  const exercisedRiskIds = new Set([...uniqueExecutions.values()].map((item) => item.riskId).filter((riskId) => knownRiskIds.has(riskId)));
  const passed = [...uniqueExecutions.values()].filter((item) => item.result === 'PASSED').length;
  const failed = [...uniqueExecutions.values()].filter((item) => item.result === 'FAILED').length;
  const unknown = Math.max(0, knownRisks - uniqueExecutions.size);
  const coveragePct = knownRisks > 0 ? Math.round((exercisedRiskIds.size / knownRisks) * 1_000) / 10 : 0;

  const sourceGaps = Object.entries(signals.sources)
    .filter(([, available]) => !available)
    .map(([source]) => `Fonte obrigatória indisponível: ${source}.`);
  const coverageGap = unknown > 0 ? `${unknown} riscos conhecidos não possuem evidência serializada nesta coleta.` : null;
  const observabilityGap = signals.observability.missingSpanScenarios > 0
    ? `${signals.observability.missingSpanScenarios} cenários de observabilidade possuem cadeia parcial de spans e exigem interpretação humana.`
    : null;
  const invalidGap = signals.invalidEvidenceFiles > 0 ? `${signals.invalidEvidenceFiles} arquivos de evidência inválidos foram ignorados.` : null;
  const historyGap = signals.hasHistoricalSeries ? null : 'Baseline e current permitem comparação pontual, mas ainda não formam série histórica.';
  const knownGaps = [coverageGap, observabilityGap, invalidGap, historyGap, ...sourceGaps].filter((item): item is string => Boolean(item));

  const coverageStatus: QualityStatus = knownRisks === 0 ? 'UNKNOWN' : coveragePct >= 80 ? 'GREEN' : coveragePct >= 50 ? 'YELLOW' : 'RED';
  const controlsStatus: QualityStatus = uniqueExecutions.size === 0 ? 'UNKNOWN' : failed > 0 ? 'RED' : unknown > 0 ? 'YELLOW' : 'GREEN';
  const journeyStatus = executionStatus(signals.journeys.total, signals.journeys.failed + signals.journeys.slaBreached);
  const resilienceStatus = executionStatus(signals.resilience.total, signals.resilience.failed);
  const observabilityStatus: QualityStatus = signals.observability.total === 0
    ? 'UNKNOWN'
    : signals.observability.failed > 0 ? 'RED' : signals.observability.missingSpanScenarios > 0 ? 'YELLOW' : 'GREEN';
  const performanceStatus: QualityStatus = signals.performance.result === 'UNKNOWN'
    ? 'UNKNOWN'
    : signals.performance.result === 'FAILED' || signals.performance.thresholdStatus === 'BREACHED' ? 'RED' : 'GREEN';
  const regressionStatus: QualityStatus = signals.performance.comparisonStatus === 'NO_BASELINE'
    ? 'UNKNOWN'
    : signals.performance.comparisonStatus === 'REGRESSED' ? 'RED' : 'GREEN';
  const gapStatus: QualityStatus = knownGaps.length > 0 ? 'YELLOW' : 'GREEN';
  const performanceTrend = comparisonTrend(signals.performance.comparisonStatus);

  const dimensions: ScorecardDimension[] = [
    {
      key: 'RISK_COVERAGE', label: 'Risk Coverage', status: coverageStatus, trend: 'UNKNOWN',
      evidence: [evidence('docs/04-quality-risk-map.md', 'RISK_MAP', `${exercisedRiskIds.size}/${knownRisks} riscos exercitados`)],
      indicators: [
        indicator('known-risks', 'Riscos conhecidos', knownRisks, knownRisks > 0 ? 'GREEN' : 'UNKNOWN'),
        indicator('exercised-risks', 'Riscos exercitados', exercisedRiskIds.size, coverageStatus),
        indicator('coverage-pct', 'Cobertura', coveragePct, coverageStatus, '%'),
      ],
      explanation: `Cobertura calculada por risco conhecido com ao menos um controle presente nas evidências serializadas desta coleta.`,
      risks: [...knownRiskIds].filter((riskId) => !exercisedRiskIds.has(riskId)),
    },
    {
      key: 'CONTROLS', label: 'Controls', status: controlsStatus, trend: 'UNKNOWN',
      evidence: [evidence('evidence/{resiliency,observability,journeys,performance}', 'RISK_MAP', `${uniqueExecutions.size} controles com resultado`)],
      indicators: [
        indicator('controls-passed', 'Aprovados', passed, passed > 0 ? 'GREEN' : 'UNKNOWN'),
        indicator('controls-failed', 'Falhos', failed, failed > 0 ? 'RED' : 'GREEN'),
        indicator('controls-unknown', 'Sem evidência', unknown, unknown > 0 ? 'YELLOW' : 'GREEN'),
      ],
      explanation: 'Consolidação deduplicada por controlId; ausência de arquivo não é convertida em aprovação.',
      risks: [...uniqueExecutions.values()].filter((item) => item.result === 'FAILED').map((item) => item.riskId),
    },
    {
      key: 'CRITICAL_JOURNEYS', label: 'Critical Journeys', status: journeyStatus, trend: 'UNKNOWN',
      evidence: [evidence('evidence/journeys/*.json', 'JOURNEY', `${signals.journeys.passed}/${signals.journeys.total} aprovadas`)],
      indicators: [
        indicator('journeys-passed', 'Aprovadas', signals.journeys.passed, journeyStatus),
        indicator('journeys-failed', 'Falhas', signals.journeys.failed, signals.journeys.failed > 0 ? 'RED' : journeyStatus),
        indicator('sla-breached', 'SLA violado', signals.journeys.slaBreached, signals.journeys.slaBreached > 0 ? 'RED' : journeyStatus),
        indicator('journey-e2e-max', 'E2E máximo', signals.journeys.endToEndMaxMs, journeyStatus, 'ms'),
      ],
      explanation: 'Resultado e SLA sintético são lidos das jornadas ponta a ponta; qualquer falha ou breach torna a dimensão vermelha.',
      risks: signals.controlExecutions.filter((item) => item.kind === 'JOURNEY' && item.result === 'FAILED').map((item) => item.riskId),
    },
    {
      key: 'RESILIENCE', label: 'Resilience', status: resilienceStatus, trend: 'UNKNOWN',
      evidence: [evidence('evidence/resiliency/*.json', 'RESILIENCY', `${signals.resilience.passed}/${signals.resilience.total} cenários recuperados`)],
      indicators: [
        indicator('resilience-passed', 'Aprovados', signals.resilience.passed, resilienceStatus),
        indicator('recovery-min', 'Recovery mínimo', signals.resilience.recoveryMinMs, resilienceStatus, 'ms'),
        indicator('recovery-avg', 'Recovery médio', signals.resilience.recoveryAvgMs, resilienceStatus, 'ms'),
        indicator('recovery-max', 'Recovery máximo', signals.resilience.recoveryMaxMs, resilienceStatus, 'ms'),
      ],
      explanation: 'Cenários [LAB] verificam recuperação e consistência nas falhas distribuídas efetivamente exercitadas.',
      risks: signals.controlExecutions.filter((item) => item.kind === 'RESILIENCY' && item.result === 'FAILED').map((item) => item.riskId),
    },
    {
      key: 'OBSERVABILITY', label: 'Observability', status: observabilityStatus, trend: 'UNKNOWN',
      evidence: [evidence('evidence/observability/*.json', 'OBSERVABILITY', `${signals.observability.traces} traces analisados`)],
      indicators: [
        indicator('traces', 'Traces', signals.observability.traces, observabilityStatus),
        indicator('error-traces', 'Traces com erro', signals.observability.errorTraces, signals.observability.errorTraces > 0 ? 'YELLOW' : observabilityStatus),
        indicator('missing-spans', 'Cadeias parciais', signals.observability.missingSpanScenarios, signals.observability.missingSpanScenarios > 0 ? 'YELLOW' : observabilityStatus),
        indicator('obs-failed', 'Controles falhos', signals.observability.failed, signals.observability.failed > 0 ? 'RED' : observabilityStatus),
      ],
      explanation: 'Spans ERROR esperados em falhas simuladas não reprovam sozinhos; controles falhos reprovam e cadeias parciais pedem revisão.',
      risks: signals.controlExecutions.filter((item) => item.kind === 'OBSERVABILITY' && item.result === 'FAILED').map((item) => item.riskId),
    },
    {
      key: 'PERFORMANCE', label: 'Performance', status: performanceStatus, trend: performanceTrend,
      evidence: [evidence('evidence/performance/current.json', 'PERFORMANCE', signals.performance.result)],
      indicators: [
        indicator('p50', 'p50', signals.performance.p50Ms ?? 'N/D', performanceStatus, signals.performance.p50Ms === null ? undefined : 'ms'),
        indicator('p95', 'p95', signals.performance.p95Ms ?? 'N/D', performanceStatus, signals.performance.p95Ms === null ? undefined : 'ms'),
        indicator('p99', 'p99', signals.performance.p99Ms ?? 'N/D', performanceStatus, signals.performance.p99Ms === null ? undefined : 'ms'),
        indicator('throughput', 'Throughput', signals.performance.throughputRps ?? 'N/D', performanceStatus, signals.performance.throughputRps === null ? undefined : 'req/s'),
      ],
      explanation: `Thresholds sintéticos: ${signals.performance.thresholdStatus}; error rate ${signals.performance.errorRate ?? 'N/D'}; E2E p95 ${signals.performance.e2eP95Ms ?? 'N/D'} ms.`,
      risks: signals.performance.result === 'FAILED' ? PERFORMANCE_CONTROLS.map((item) => item.riskId) : [],
    },
    {
      key: 'REGRESSION', label: 'Regression', status: regressionStatus, trend: performanceTrend,
      evidence: [
        evidence('evidence/performance/current.json', 'PERFORMANCE', signals.performance.comparisonStatus),
        evidence('evidence/performance/baseline.json', 'BASELINE', signals.sources.performanceBaseline ? 'AVAILABLE' : 'MISSING'),
      ],
      indicators: [
        indicator('comparison', 'Comparação', signals.performance.comparisonStatus, regressionStatus),
        indicator('regressed-metrics', 'Métricas regredidas', signals.performance.regressedMetrics.length, regressionStatus),
        indicator('tolerance', 'Tolerância', signals.performance.tolerancePct === null ? 'N/D' : signals.performance.tolerancePct * 100, regressionStatus, signals.performance.tolerancePct === null ? undefined : '%'),
      ],
      explanation: 'Baseline versus current é uma comparação pontual determinística; não representa tendência histórica.',
      risks: signals.performance.regressedMetrics.length > 0 ? ['RISK-PERF-005'] : [],
    },
    {
      key: 'KNOWN_GAPS', label: 'Known Gaps', status: gapStatus, trend: 'UNKNOWN',
      evidence: [evidence('scorecard deterministic normalization', 'RISK_MAP', `${knownGaps.length} gaps explicitados`)],
      indicators: [
        indicator('known-gaps', 'Gaps conhecidos', knownGaps.length, gapStatus),
        indicator('invalid-files', 'Evidências inválidas', signals.invalidEvidenceFiles, signals.invalidEvidenceFiles > 0 ? 'YELLOW' : 'GREEN'),
        indicator('missing-sources', 'Fontes ausentes', sourceGaps.length, sourceGaps.length > 0 ? 'YELLOW' : 'GREEN'),
      ],
      explanation: 'Lacunas permanecem visíveis e nunca são interpretadas como sucesso implícito.',
      risks: [...knownRiskIds].filter((riskId) => !exercisedRiskIds.has(riskId)),
    },
  ];

  const calculatedOverall = overallStatus(dimensions);
  const overallTrend = performanceTrend;
  const overallDimension: ScorecardDimension = {
    key: 'OVERALL_QUALITY', label: 'Overall Quality', status: calculatedOverall, trend: overallTrend,
    evidence: [evidence('evidence/scorecard/current.json', 'RISK_MAP', 'síntese das oito dimensões')],
    indicators: [
      indicator('risk-coverage', 'Risk coverage', coveragePct, coverageStatus, '%'),
      indicator('failed-controls', 'Controles falhos', failed, failed > 0 ? 'RED' : 'GREEN'),
      indicator('failed-journeys', 'Jornadas falhas', signals.journeys.failed, signals.journeys.failed > 0 ? 'RED' : journeyStatus),
      indicator('known-gaps', 'Gaps conhecidos', knownGaps.length, gapStatus),
    ],
    explanation: 'Pior status determinístico entre as dimensões; UNKNOWN é preservado quando não há evidência operacional suficiente.',
    risks: dimensions.flatMap((dimension) => dimension.risks).filter((riskId, index, values) => values.indexOf(riskId) === index),
  };

  return parseExecutiveScorecard({
    schemaVersion: '1.0.0',
    rulesVersion: 'scorecard-rules-v1',
    generatedAt: metadata.generatedAt ?? new Date().toISOString(),
    commit: metadata.commit ?? resolveCommit(),
    scope: '[LAB] Cloud Control Plane fictício',
    decisionAuthority: 'HUMAN',
    overallStatus: calculatedOverall,
    overallTrend,
    summary: {
      knownRisks,
      exercisedRisks: exercisedRiskIds.size,
      riskCoveragePct: coveragePct,
      controlsPassed: passed,
      controlsFailed: failed,
      controlsUnknown: unknown,
      journeysPassed: signals.journeys.passed,
      journeysTotal: signals.journeys.total,
      syntheticSlaMet: signals.journeys.slaMet,
      syntheticSlaTotal: signals.journeys.total,
      knownGapCount: knownGaps.length,
    },
    dimensions: [overallDimension, ...dimensions],
    knownGaps,
    trendDisclaimer: 'Comparação pontual entre baseline e execução atual; não constitui série histórica.',
    syntheticSlaDisclaimer: 'SLAs sintéticos do laboratório não representam SLA real da TOTVS.',
  });
}

function resolveCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function writeScorecardArtifacts(scorecard: ExecutiveScorecard, repositoryRoot = process.cwd()): Promise<string[]> {
  const targetDir = path.join(repositoryRoot, 'evidence', 'scorecard');
  fs.mkdirSync(targetDir, { recursive: true });
  const outputs = {
    json: path.join(targetDir, 'current.json'),
    markdown: path.join(targetDir, 'executive-summary.md'),
    html: path.join(targetDir, 'executive-scorecard.html'),
    pdf: path.join(targetDir, 'executive-scorecard.pdf'),
  };
  fs.writeFileSync(outputs.json, `${JSON.stringify(scorecard, null, 2)}\n`, 'utf8');
  fs.writeFileSync(outputs.markdown, renderExecutiveSummaryMarkdown(scorecard), 'utf8');
  fs.writeFileSync(outputs.html, renderScorecardHtml(scorecard), 'utf8');
  fs.writeFileSync(outputs.pdf, await renderScorecardPdf(scorecard));
  return Object.values(outputs);
}

async function main(): Promise<void> {
  const signals = loadScorecardSignals();
  const scorecard = buildExecutiveScorecard(signals, {
    ...(process.env.QE_SCORECARD_GENERATED_AT ? { generatedAt: process.env.QE_SCORECARD_GENERATED_AT } : {}),
  });
  const files = await writeScorecardArtifacts(scorecard);
  process.stdout.write(`Scorecard ${scorecard.overallStatus} gerado: ${files.map((file) => path.relative(process.cwd(), file)).join(', ')}\n`);
}

const executedFile = process.argv[1];
if (executedFile && import.meta.url === pathToFileURL(executedFile).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`Falha ao gerar scorecard: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
