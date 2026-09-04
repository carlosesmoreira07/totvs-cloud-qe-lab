import fs from 'node:fs';
import path from 'node:path';

import {
  loadResiliencyData,
  type NormalizedResiliencyEvidence,
  type ResiliencyDurationStats,
} from './evidence-loader.js';

export const EXPECTED_DISTRIBUTED_SPANS = [
  'http.request',
  'db.transaction.create_instance',
  'outbox.create_event',
  'nats.publish',
  'nats.consume',
  'db.transaction.update_state',
] as const;

export interface NormalizedSpan {
  name: string;
  spanId: string;
  parentSpanId?: string | undefined;
  status: string;
  attributes: Record<string, unknown>;
}

export interface NormalizedObservabilityEvidence {
  scenario: string;
  riskId: string;
  controlId: string;
  traceId: string;
  correlationId: string;
  spansObserved: NormalizedSpan[];
  metricsObserved: Record<string, number>;
  observedIssue?: string | undefined;
  finalState: Record<string, unknown>;
  result: 'PASSED' | 'FAILED';
}

export interface MissingSpanFinding {
  scenario: string;
  traceId: string;
  missingSpans: string[];
}

export interface ErrorSpanFinding {
  scenario: string;
  traceId: string;
  spanName: string;
  status: string;
  observedIssue?: string | undefined;
}

export interface TelemetryMetricsAggregation {
  httpRequestsTotal: number;
  httpErrorsTotal: number;
  outboxPendingCount: number;
  outboxPublishFailuresTotal: number;
  messagesProcessedTotal: number;
  consumerFailuresTotal: number;
  messageRedeliveriesTotal: number;
}

export interface DeterministicTelemetryCorrelation {
  totalTraces: number;
  totalObservabilityScenarios: number;
  totalResiliencyScenarios: number;
  observedSpans: string[];
  missingSpans: MissingSpanFinding[];
  errorTraces: ErrorSpanFinding[];
  exercisedRisks: string[];
  exercisedControls: string[];
  metricsSummary: TelemetryMetricsAggregation;
  observedFailures: string[];
  recoveryDuration: ResiliencyDurationStats;
  relatedCorrelationIds: string[];
  relatedTraceIds: string[];
}

export interface LoadedTelemetryData {
  observabilityEvidences: NormalizedObservabilityEvidence[];
  resiliencyEvidences: NormalizedResiliencyEvidence[];
  correlation: DeterministicTelemetryCorrelation;
  invalidFileCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeObservabilityEvidence(raw: unknown): NormalizedObservabilityEvidence | null {
  if (!isRecord(raw)) return null;

  const scenario = typeof raw.scenario === 'string' ? raw.scenario.trim() : '';
  const riskId = typeof raw.riskId === 'string' ? raw.riskId.trim() : '';
  const controlId = typeof raw.controlId === 'string' ? raw.controlId.trim() : '';
  const traceId = typeof raw.traceId === 'string' ? raw.traceId.trim() : '';
  const correlationId = typeof raw.correlationId === 'string' ? raw.correlationId.trim() : '';
  const observedIssue = typeof raw.observedIssue === 'string' && raw.observedIssue.trim() ? raw.observedIssue.trim() : undefined;
  const finalState = isRecord(raw.finalState) ? raw.finalState : {};
  const result = raw.result === 'PASSED' || raw.result === 'FAILED' ? raw.result : 'FAILED';

  if (!scenario || !riskId || !controlId || !traceId || !correlationId) {
    return null;
  }

  const spansObserved: NormalizedSpan[] = [];
  if (Array.isArray(raw.spansObserved)) {
    for (const span of raw.spansObserved) {
      if (isRecord(span) && typeof span.name === 'string' && typeof span.spanId === 'string') {
        spansObserved.push({
          name: span.name.trim(),
          spanId: span.spanId.trim(),
          parentSpanId: typeof span.parentSpanId === 'string' ? span.parentSpanId.trim() : undefined,
          status: typeof span.status === 'string' ? span.status.trim() : 'UNKNOWN',
          attributes: isRecord(span.attributes) ? span.attributes : {},
        });
      }
    }
  }

  const metricsObserved: Record<string, number> = {};
  if (isRecord(raw.metricsObserved)) {
    for (const [key, val] of Object.entries(raw.metricsObserved)) {
      if (typeof val === 'number' && Number.isFinite(val)) {
        metricsObserved[key] = val;
      }
    }
  }

  return {
    scenario,
    riskId,
    controlId,
    traceId,
    correlationId,
    spansObserved,
    metricsObserved,
    observedIssue,
    finalState,
    result,
  };
}

export function computeTelemetryCorrelation(
  observabilityEvidences: NormalizedObservabilityEvidence[],
  resiliencyEvidences: NormalizedResiliencyEvidence[],
): DeterministicTelemetryCorrelation {
  const allSpanNames = new Set<string>();
  const missingSpans: MissingSpanFinding[] = [];
  const errorTraces: ErrorSpanFinding[] = [];
  const risks = new Set<string>();
  const controls = new Set<string>();
  const failures = new Set<string>();
  const correlationIds = new Set<string>();
  const traceIds = new Set<string>();

  // Aggregate metrics tracking maximum values observed in scenarios
  let httpRequestsTotal = 0;
  let httpErrorsTotal = 0;
  let outboxPendingCount = 0;
  let outboxPublishFailuresTotal = 0;
  let messagesProcessedTotal = 0;
  let consumerFailuresTotal = 0;
  let messageRedeliveriesTotal = 0;

  for (const obs of observabilityEvidences) {
    if (obs.riskId) risks.add(obs.riskId);
    if (obs.controlId) controls.add(obs.controlId);
    if (obs.traceId) traceIds.add(obs.traceId);
    if (obs.correlationId) correlationIds.add(obs.correlationId);
    if (obs.observedIssue && obs.observedIssue !== 'NONE') {
      failures.add(obs.observedIssue);
    }

    const presentSpans = new Set<string>();
    for (const span of obs.spansObserved) {
      allSpanNames.add(span.name);
      presentSpans.add(span.name);
      if (span.status === 'ERROR') {
        errorTraces.push({
          scenario: obs.scenario,
          traceId: obs.traceId,
          spanName: span.name,
          status: span.status,
          observedIssue: obs.observedIssue,
        });
      }
    }

    // Check if any expected span is missing for this trace
    const missing = EXPECTED_DISTRIBUTED_SPANS.filter((expected) => !presentSpans.has(expected));
    if (missing.length > 0) {
      missingSpans.push({
        scenario: obs.scenario,
        traceId: obs.traceId,
        missingSpans: missing,
      });
    }

    // Metrics aggregation (take maximum or accumulate relevant counters)
    const m = obs.metricsObserved;
    if (typeof m.http_requests_total === 'number' && m.http_requests_total > httpRequestsTotal) {
      httpRequestsTotal = m.http_requests_total;
    }
    if (typeof m.http_errors_total === 'number' && m.http_errors_total > httpErrorsTotal) {
      httpErrorsTotal = m.http_errors_total;
    }
    if (typeof m.outbox_pending_count === 'number' && m.outbox_pending_count > outboxPendingCount) {
      outboxPendingCount = m.outbox_pending_count;
    }
    if (typeof m.outbox_publish_failures_total === 'number' && m.outbox_publish_failures_total > outboxPublishFailuresTotal) {
      outboxPublishFailuresTotal = m.outbox_publish_failures_total;
    }
    if (typeof m.messages_processed_total === 'number' && m.messages_processed_total > messagesProcessedTotal) {
      messagesProcessedTotal = m.messages_processed_total;
    }
    if (typeof m.consumer_failures_total === 'number' && m.consumer_failures_total > consumerFailuresTotal) {
      consumerFailuresTotal = m.consumer_failures_total;
    }
    if (typeof m.message_redeliveries_total === 'number' && m.message_redeliveries_total > messageRedeliveriesTotal) {
      messageRedeliveriesTotal = m.message_redeliveries_total;
    }
  }

  // Include resiliency risks, controls, failures and recovery duration stats
  let minDuration = Number.POSITIVE_INFINITY;
  let maxDuration = 0;
  let totalDuration = 0;

  for (const res of resiliencyEvidences) {
    if (res.riskId) risks.add(res.riskId);
    if (res.controlId) controls.add(res.controlId);
    if (res.observedFailure && res.observedFailure !== 'NONE') {
      failures.add(res.observedFailure);
    }
    if (res.durationMs < minDuration) minDuration = res.durationMs;
    if (res.durationMs > maxDuration) maxDuration = res.durationMs;
    totalDuration += res.durationMs;
  }

  const durationStats: ResiliencyDurationStats = resiliencyEvidences.length > 0
    ? {
        min: minDuration === Number.POSITIVE_INFINITY ? 0 : minDuration,
        max: maxDuration,
        avg: Math.round(totalDuration / resiliencyEvidences.length),
      }
    : { min: 0, max: 0, avg: 0 };

  return {
    totalTraces: traceIds.size,
    totalObservabilityScenarios: observabilityEvidences.length,
    totalResiliencyScenarios: resiliencyEvidences.length,
    observedSpans: [...allSpanNames].sort(),
    missingSpans,
    errorTraces,
    exercisedRisks: [...risks].sort(),
    exercisedControls: [...controls].sort(),
    metricsSummary: {
      httpRequestsTotal,
      httpErrorsTotal,
      outboxPendingCount,
      outboxPublishFailuresTotal,
      messagesProcessedTotal,
      consumerFailuresTotal,
      messageRedeliveriesTotal,
    },
    observedFailures: [...failures].sort(),
    recoveryDuration: durationStats,
    relatedCorrelationIds: [...correlationIds].sort(),
    relatedTraceIds: [...traceIds].sort(),
  };
}

export function loadTelemetryData(
  observabilityDir?: string,
  resiliencyDir?: string,
): LoadedTelemetryData {
  const obsDir = observabilityDir ? path.resolve(observabilityDir) : path.resolve(process.cwd(), 'evidence', 'observability');
  const resData = loadResiliencyData(resiliencyDir);

  if (!fs.existsSync(obsDir)) {
    return {
      observabilityEvidences: [],
      resiliencyEvidences: resData.evidences,
      correlation: computeTelemetryCorrelation([], resData.evidences),
      invalidFileCount: resData.invalidFileCount,
    };
  }

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(obsDir);
  } catch {
    return {
      observabilityEvidences: [],
      resiliencyEvidences: resData.evidences,
      correlation: computeTelemetryCorrelation([], resData.evidences),
      invalidFileCount: resData.invalidFileCount,
    };
  }

  const jsonFiles = entries.filter((file) => file.endsWith('.json')).sort();
  const observabilityEvidences: NormalizedObservabilityEvidence[] = [];
  let invalidFileCount = 0;

  for (const file of jsonFiles) {
    const fullPath = path.join(obsDir, file);
    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      const parsed = JSON.parse(content);
      const normalized = normalizeObservabilityEvidence(parsed);
      if (normalized) {
        observabilityEvidences.push(normalized);
      } else {
        invalidFileCount += 1;
      }
    } catch {
      invalidFileCount += 1;
    }
  }

  return {
    observabilityEvidences,
    resiliencyEvidences: resData.evidences,
    correlation: computeTelemetryCorrelation(observabilityEvidences, resData.evidences),
    invalidFileCount: invalidFileCount + resData.invalidFileCount,
  };
}
