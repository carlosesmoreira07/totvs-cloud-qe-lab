import fs from 'node:fs';
import path from 'node:path';

export interface NormalizedResiliencyEvidence {
  scenario: string;
  riskId: string;
  controlId: string;
  observedFailure: string;
  startedAt: string;
  recoveredAt: string;
  durationMs: number;
  finalState: Record<string, unknown>;
  result: 'PASSED' | 'FAILED';
}

export interface ResiliencyDurationStats {
  min: number;
  max: number;
  avg: number;
}

export interface ResiliencyMetricsSummary {
  totalScenarios: number;
  passed: number;
  failed: number;
  durationMs: ResiliencyDurationStats;
  exercisedRisks: string[];
  exercisedControls: string[];
  observedFailures: string[];
}

export interface LoadedResiliencyData {
  evidences: NormalizedResiliencyEvidence[];
  metrics: ResiliencyMetricsSummary;
  invalidFileCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeEvidence(raw: unknown): NormalizedResiliencyEvidence | null {
  if (!isRecord(raw)) return null;

  const scenario = typeof raw.scenario === 'string' ? raw.scenario.trim() : '';
  const riskId = typeof raw.riskId === 'string' ? raw.riskId.trim() : '';
  const controlId = typeof raw.controlId === 'string' ? raw.controlId.trim() : '';
  const observedFailure = typeof raw.observedFailure === 'string' ? raw.observedFailure.trim() : 'NONE';
  const startedAt = typeof raw.startedAt === 'string' ? raw.startedAt.trim() : '';
  const recoveredAt = typeof raw.recoveredAt === 'string' ? raw.recoveredAt.trim() : '';
  const durationMs = typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs) ? Math.max(0, raw.durationMs) : 0;
  const finalState = isRecord(raw.finalState) ? raw.finalState : {};
  const result = raw.result === 'PASSED' || raw.result === 'FAILED' ? raw.result : 'FAILED';

  if (!scenario || !riskId || !controlId) {
    return null;
  }

  return {
    scenario,
    riskId,
    controlId,
    observedFailure,
    startedAt,
    recoveredAt,
    durationMs,
    finalState,
    result,
  };
}

export function computeResiliencyMetrics(evidences: NormalizedResiliencyEvidence[]): ResiliencyMetricsSummary {
  if (evidences.length === 0) {
    return {
      totalScenarios: 0,
      passed: 0,
      failed: 0,
      durationMs: { min: 0, max: 0, avg: 0 },
      exercisedRisks: [],
      exercisedControls: [],
      observedFailures: [],
    };
  }

  let passed = 0;
  let failed = 0;
  let minDuration = Number.POSITIVE_INFINITY;
  let maxDuration = 0;
  let totalDuration = 0;

  const risks = new Set<string>();
  const controls = new Set<string>();
  const failures = new Set<string>();

  for (const item of evidences) {
    if (item.result === 'PASSED') {
      passed += 1;
    } else {
      failed += 1;
    }

    if (item.durationMs < minDuration) minDuration = item.durationMs;
    if (item.durationMs > maxDuration) maxDuration = item.durationMs;
    totalDuration += item.durationMs;

    if (item.riskId) risks.add(item.riskId);
    if (item.controlId) controls.add(item.controlId);
    if (item.observedFailure && item.observedFailure !== 'NONE') {
      failures.add(item.observedFailure);
    }
  }

  return {
    totalScenarios: evidences.length,
    passed,
    failed,
    durationMs: {
      min: minDuration === Number.POSITIVE_INFINITY ? 0 : minDuration,
      max: maxDuration,
      avg: Math.round(totalDuration / evidences.length),
    },
    exercisedRisks: [...risks].sort(),
    exercisedControls: [...controls].sort(),
    observedFailures: [...failures].sort(),
  };
}

export function loadResiliencyData(dirPath?: string): LoadedResiliencyData {
  const targetDir = dirPath ? path.resolve(dirPath) : path.resolve(process.cwd(), 'evidence', 'resiliency');

  if (!fs.existsSync(targetDir)) {
    return {
      evidences: [],
      metrics: computeResiliencyMetrics([]),
      invalidFileCount: 0,
    };
  }

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(targetDir);
  } catch {
    return {
      evidences: [],
      metrics: computeResiliencyMetrics([]),
      invalidFileCount: 0,
    };
  }

  const jsonFiles = entries.filter((file) => file.endsWith('.json')).sort();
  const evidences: NormalizedResiliencyEvidence[] = [];
  let invalidFileCount = 0;

  for (const file of jsonFiles) {
    const fullPath = path.join(targetDir, file);
    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      const parsed = JSON.parse(content);
      const normalized = normalizeEvidence(parsed);
      if (normalized) {
        evidences.push(normalized);
      } else {
        invalidFileCount += 1;
      }
    } catch {
      invalidFileCount += 1;
    }
  }

  return {
    evidences,
    metrics: computeResiliencyMetrics(evidences),
    invalidFileCount,
  };
}
