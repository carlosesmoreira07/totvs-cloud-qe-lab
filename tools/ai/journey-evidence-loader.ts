import fs from 'node:fs';
import path from 'node:path';

import {
  loadResiliencyData,
  type NormalizedResiliencyEvidence,
} from './evidence-loader.js';
import {
  loadTelemetryData,
  type NormalizedObservabilityEvidence,
  type DeterministicTelemetryCorrelation,
} from './telemetry-evidence-loader.js';

export interface SlaAssessment {
  apiLatencyMet: boolean;
  endToEndMet: boolean;
  recoveryMet?: boolean | undefined;
  status: 'MET' | 'BREACHED';
  targetSla: {
    maxApiLatencyMs: number;
    maxEndToEndDurationMs: number;
    maxRecoveryDurationMs: number;
  };
}

export interface NormalizedJourneyEvidence {
  journey: string;
  riskId: string;
  controlId: string;
  startedAt: string;
  acceptedAt: string;
  completedAt: string;
  apiLatencyMs: number;
  endToEndDurationMs: number;
  recoveryDurationMs: number | null;
  traceId: string;
  correlationId: string;
  retries: number;
  redeliveries: number;
  finalState: Record<string, unknown>;
  slaAssessment: SlaAssessment;
  result: 'PASSED' | 'FAILED';
}

export interface MetricStats {
  min: number;
  max: number;
  avg: number;
}

export interface JourneyCorrelationItem {
  journey: string;
  riskId: string;
  controlId: string;
  status: 'PASSED' | 'FAILED';
  slaStatus: 'MET' | 'BREACHED';
  apiLatencyMs: number;
  endToEndDurationMs: number;
  recoveryDurationMs: number | null;
  retries: number;
  redeliveries: number;
  traceId: string;
  correlationId: string;
  relatedErrorSpans: string[];
  relatedFailures: string[];
}

export interface TrendFinding {
  journey: string;
  metric: 'apiLatency' | 'endToEndDuration' | 'recoveryDuration' | 'retries' | 'redeliveries';
  observation: string;
}

export interface DeterministicJourneyCorrelation {
  totalJourneys: number;
  passedJourneys: number;
  failedJourneys: number;
  slaMetCount: number;
  slaBreachedCount: number;
  apiLatency: MetricStats;
  endToEndDuration: MetricStats;
  recoveryDuration: MetricStats;
  totalRetries: number;
  totalRedeliveries: number;
  slowestJourney: { journey: string; endToEndDurationMs: number } | null;
  exercisedRisks: string[];
  exercisedControls: string[];
  associatedTraceIds: string[];
  associatedCorrelationIds: string[];
  observedFailures: string[];
  journeyCorrelations: JourneyCorrelationItem[];
  trendFindings: TrendFinding[];
}

export interface LoadedJourneyData {
  journeyEvidences: NormalizedJourneyEvidence[];
  observabilityEvidences: NormalizedObservabilityEvidence[];
  resiliencyEvidences: NormalizedResiliencyEvidence[];
  telemetryCorrelation: DeterministicTelemetryCorrelation;
  correlation: DeterministicJourneyCorrelation;
  invalidFileCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeJourneyEvidence(raw: unknown): NormalizedJourneyEvidence | null {
  if (!isRecord(raw)) return null;

  const journey = typeof raw.journey === 'string' ? raw.journey.trim() : '';
  const riskId = typeof raw.riskId === 'string' ? raw.riskId.trim() : '';
  const controlId = typeof raw.controlId === 'string' ? raw.controlId.trim() : '';
  const startedAt = typeof raw.startedAt === 'string' ? raw.startedAt.trim() : '';
  const acceptedAt = typeof raw.acceptedAt === 'string' ? raw.acceptedAt.trim() : '';
  const completedAt = typeof raw.completedAt === 'string' ? raw.completedAt.trim() : '';
  const apiLatencyMs = typeof raw.apiLatencyMs === 'number' && Number.isFinite(raw.apiLatencyMs) ? raw.apiLatencyMs : null;
  const endToEndDurationMs = typeof raw.endToEndDurationMs === 'number' && Number.isFinite(raw.endToEndDurationMs) ? raw.endToEndDurationMs : null;
  const recoveryDurationMs = typeof raw.recoveryDurationMs === 'number' && Number.isFinite(raw.recoveryDurationMs)
    ? raw.recoveryDurationMs
    : raw.recoveryDurationMs === null ? null : null;
  const traceId = typeof raw.traceId === 'string' ? raw.traceId.trim() : '';
  const correlationId = typeof raw.correlationId === 'string' ? raw.correlationId.trim() : '';
  const retries = typeof raw.retries === 'number' && Number.isFinite(raw.retries) ? raw.retries : 0;
  const redeliveries = typeof raw.redeliveries === 'number' && Number.isFinite(raw.redeliveries) ? raw.redeliveries : 0;
  const finalState = isRecord(raw.finalState) ? raw.finalState : {};
  const result = raw.result === 'PASSED' || raw.result === 'FAILED' ? raw.result : 'FAILED';

  if (!journey || !riskId || !controlId || apiLatencyMs === null || endToEndDurationMs === null) {
    return null;
  }

  const rawSla = isRecord(raw.slaAssessment) ? raw.slaAssessment : {};
  const targetSlaRaw = isRecord(rawSla.targetSla) ? rawSla.targetSla : {};

  const slaAssessment: SlaAssessment = {
    apiLatencyMet: rawSla.apiLatencyMet === true,
    endToEndMet: rawSla.endToEndMet === true,
    recoveryMet: typeof rawSla.recoveryMet === 'boolean' ? rawSla.recoveryMet : undefined,
    status: rawSla.status === 'MET' || rawSla.status === 'BREACHED' ? rawSla.status : 'BREACHED',
    targetSla: {
      maxApiLatencyMs: typeof targetSlaRaw.maxApiLatencyMs === 'number' ? targetSlaRaw.maxApiLatencyMs : 500,
      maxEndToEndDurationMs: typeof targetSlaRaw.maxEndToEndDurationMs === 'number' ? targetSlaRaw.maxEndToEndDurationMs : 5000,
      maxRecoveryDurationMs: typeof targetSlaRaw.maxRecoveryDurationMs === 'number' ? targetSlaRaw.maxRecoveryDurationMs : 5000,
    },
  };

  return {
    journey,
    riskId,
    controlId,
    startedAt,
    acceptedAt,
    completedAt,
    apiLatencyMs,
    endToEndDurationMs,
    recoveryDurationMs,
    traceId,
    correlationId,
    retries,
    redeliveries,
    finalState,
    slaAssessment,
    result,
  };
}

function computeStats(values: number[]): MetricStats {
  if (values.length === 0) {
    return { min: 0, max: 0, avg: 0 };
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const sum = values.reduce((acc, curr) => acc + curr, 0);
  const avg = Math.round((sum / values.length) * 10) / 10;
  return { min, max, avg };
}

export function correlateDeterministicJourneys(
  journeyEvidences: NormalizedJourneyEvidence[],
  observabilityEvidences: NormalizedObservabilityEvidence[] = [],
  resiliencyEvidences: NormalizedResiliencyEvidence[] = [],
): DeterministicJourneyCorrelation {
  const totalJourneys = journeyEvidences.length;
  const passedJourneys = journeyEvidences.filter((j) => j.result === 'PASSED').length;
  const failedJourneys = totalJourneys - passedJourneys;

  const slaMetCount = journeyEvidences.filter((j) => j.slaAssessment.status === 'MET').length;
  const slaBreachedCount = totalJourneys - slaMetCount;

  const apiLatencies = journeyEvidences.map((j) => j.apiLatencyMs);
  const endToEndDurations = journeyEvidences.map((j) => j.endToEndDurationMs);
  const recoveryDurations = journeyEvidences
    .map((j) => j.recoveryDurationMs)
    .filter((v): v is number => v !== null && v !== undefined);

  const apiLatency = computeStats(apiLatencies);
  const endToEndDuration = computeStats(endToEndDurations);
  const recoveryDuration = computeStats(recoveryDurations);

  const totalRetries = journeyEvidences.reduce((acc, j) => acc + j.retries, 0);
  const totalRedeliveries = journeyEvidences.reduce((acc, j) => acc + j.redeliveries, 0);

  let slowestJourney: { journey: string; endToEndDurationMs: number } | null = null;
  for (const j of journeyEvidences) {
    if (!slowestJourney || j.endToEndDurationMs > slowestJourney.endToEndDurationMs) {
      slowestJourney = { journey: j.journey, endToEndDurationMs: j.endToEndDurationMs };
    }
  }

  const exercisedRisks = Array.from(new Set(journeyEvidences.map((j) => j.riskId))).sort();
  const exercisedControls = Array.from(new Set(journeyEvidences.map((j) => j.controlId))).sort();
  const associatedTraceIds = Array.from(new Set(journeyEvidences.map((j) => j.traceId).filter(Boolean))).sort();
  const associatedCorrelationIds = Array.from(new Set(journeyEvidences.map((j) => j.correlationId).filter(Boolean))).sort();

  // Mapeamento de falhas observadas em observability e resiliency
  const observedFailures = Array.from(
    new Set([
      ...resiliencyEvidences.map((r) => r.observedFailure).filter(Boolean),
      ...observabilityEvidences.map((o) => o.observedIssue).filter((x): x is string => Boolean(x)),
    ]),
  ).sort();

  // Correlações por jornada
  const journeyCorrelations: JourneyCorrelationItem[] = journeyEvidences.map((j) => {
    // Relacionar com spans de erro em observability via traceId
    const relatedObs = observabilityEvidences.filter((o) => o.traceId === j.traceId);
    const relatedErrorSpans: string[] = [];
    for (const obs of relatedObs) {
      for (const span of obs.spansObserved) {
        if (span.status === 'ERROR' || span.status === '2') {
          relatedErrorSpans.push(`${span.name} (${span.spanId})`);
        }
      }
    }

    // Relacionar com falhas por correlação ou cenário
    const relatedFailures: string[] = [];
    if (j.journey.includes('nats-failure') || j.riskId === 'RISK-JOURNEY-003') {
      relatedFailures.push('SIMULATED_PUBLISH_FAILURE / NATS_OUTAGE');
    }
    if (j.journey.includes('consumer-failure') || j.riskId === 'RISK-JOURNEY-004') {
      relatedFailures.push('SIMULATED_CONSUMER_PROCESSING_FAILURE');
    }
    if (j.retries > 0) {
      relatedFailures.push('IDEMPOTENT_CLIENT_RETRY');
    }

    return {
      journey: j.journey,
      riskId: j.riskId,
      controlId: j.controlId,
      status: j.result,
      slaStatus: j.slaAssessment.status,
      apiLatencyMs: j.apiLatencyMs,
      endToEndDurationMs: j.endToEndDurationMs,
      recoveryDurationMs: j.recoveryDurationMs,
      retries: j.retries,
      redeliveries: j.redeliveries,
      traceId: j.traceId,
      correlationId: j.correlationId,
      relatedErrorSpans: Array.from(new Set(relatedErrorSpans)),
      relatedFailures: Array.from(new Set(relatedFailures)),
    };
  });

  // Detecção de tendências se houver múltiplas evidências da mesma jornada
  const trendFindings: TrendFinding[] = [];
  const groupedByName = new Map<string, NormalizedJourneyEvidence[]>();
  for (const j of journeyEvidences) {
    const list = groupedByName.get(j.journey) ?? [];
    list.push(j);
    groupedByName.set(j.journey, list);
  }

  for (const [name, items] of groupedByName.entries()) {
    if (items.length >= 2) {
      const sorted = [...items].sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
      const first = sorted[0]!;
      const last = sorted[sorted.length - 1]!;

      if (last.endToEndDurationMs > first.endToEndDurationMs * 1.5) {
        trendFindings.push({
          journey: name,
          metric: 'endToEndDuration',
          observation: `Duração E2E aumentou de ${first.endToEndDurationMs}ms para ${last.endToEndDurationMs}ms entre execuções`,
        });
      }
      if (last.apiLatencyMs > first.apiLatencyMs * 1.5) {
        trendFindings.push({
          journey: name,
          metric: 'apiLatency',
          observation: `Latência de API aumentou de ${first.apiLatencyMs}ms para ${last.apiLatencyMs}ms entre execuções`,
        });
      }
      if (last.retries > first.retries) {
        trendFindings.push({
          journey: name,
          metric: 'retries',
          observation: `Contagem de retries aumentou de ${first.retries} para ${last.retries}`,
        });
      }
    }
  }

  return {
    totalJourneys,
    passedJourneys,
    failedJourneys,
    slaMetCount,
    slaBreachedCount,
    apiLatency,
    endToEndDuration,
    recoveryDuration,
    totalRetries,
    totalRedeliveries,
    slowestJourney,
    exercisedRisks,
    exercisedControls,
    associatedTraceIds,
    associatedCorrelationIds,
    observedFailures,
    journeyCorrelations,
    trendFindings,
  };
}

export function loadJourneyData(
  journeysDir?: string,
  observabilityDir?: string,
  resiliencyDir?: string,
): LoadedJourneyData {
  const resolvedJourneysDir = journeysDir ?? path.resolve(process.cwd(), 'evidence', 'journeys');
  const resolvedObsDir = observabilityDir ?? path.resolve(process.cwd(), 'evidence', 'observability');
  const resolvedResDir = resiliencyDir ?? path.resolve(process.cwd(), 'evidence', 'resiliency');

  const journeyEvidences: NormalizedJourneyEvidence[] = [];
  let invalidFileCount = 0;

  if (fs.existsSync(resolvedJourneysDir)) {
    try {
      const files = fs.readdirSync(resolvedJourneysDir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        const fullPath = path.join(resolvedJourneysDir, file);
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          const parsed = JSON.parse(content) as unknown;
          const normalized = normalizeJourneyEvidence(parsed);
          if (normalized) {
            journeyEvidences.push(normalized);
          } else {
            invalidFileCount++;
          }
        } catch {
          invalidFileCount++;
        }
      }
    } catch {
      // tolerar erro de leitura do diretório
    }
  }

  // Ordenar por nome da jornada para determinismo
  journeyEvidences.sort((a, b) => a.journey.localeCompare(b.journey));

  const loadedTelemetry = loadTelemetryData(resolvedObsDir, resolvedResDir);
  const resiliencyData = loadResiliencyData(resolvedResDir);

  const correlation = correlateDeterministicJourneys(
    journeyEvidences,
    loadedTelemetry.observabilityEvidences,
    resiliencyData.evidences,
  );

  return {
    journeyEvidences,
    observabilityEvidences: loadedTelemetry.observabilityEvidences,
    resiliencyEvidences: resiliencyData.evidences,
    telemetryCorrelation: loadedTelemetry.correlation,
    correlation,
    invalidFileCount,
  };
}
