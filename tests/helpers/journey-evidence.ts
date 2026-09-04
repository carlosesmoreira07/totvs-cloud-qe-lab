import fs from 'node:fs';
import path from 'node:path';

export const LAB_SYNTHETIC_SLA = {
  maxApiLatencyMs: 500,
  maxEndToEndDurationMs: 5000,
  maxRecoveryDurationMs: 5000,
} as const;

export interface SlaAssessment {
  apiLatencyMet: boolean;
  endToEndMet: boolean;
  recoveryMet: boolean;
  status: 'MET' | 'BREACHED';
  targetSla: {
    maxApiLatencyMs: number;
    maxEndToEndDurationMs: number;
    maxRecoveryDurationMs: number;
  };
}

export interface SyntheticJourneyEvidence {
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

export function evaluateSla(params: {
  apiLatencyMs: number;
  endToEndDurationMs: number;
  recoveryDurationMs?: number | null;
}): SlaAssessment {
  const apiLatencyMet = params.apiLatencyMs <= LAB_SYNTHETIC_SLA.maxApiLatencyMs;
  const endToEndMet = params.endToEndDurationMs <= LAB_SYNTHETIC_SLA.maxEndToEndDurationMs;
  const recoveryMet =
    params.recoveryDurationMs === null ||
    params.recoveryDurationMs === undefined ||
    params.recoveryDurationMs <= LAB_SYNTHETIC_SLA.maxRecoveryDurationMs;

  const status: 'MET' | 'BREACHED' = apiLatencyMet && endToEndMet && recoveryMet ? 'MET' : 'BREACHED';

  return {
    apiLatencyMet,
    endToEndMet,
    recoveryMet,
    status,
    targetSla: {
      maxApiLatencyMs: LAB_SYNTHETIC_SLA.maxApiLatencyMs,
      maxEndToEndDurationMs: LAB_SYNTHETIC_SLA.maxEndToEndDurationMs,
      maxRecoveryDurationMs: LAB_SYNTHETIC_SLA.maxRecoveryDurationMs,
    },
  };
}

export function recordJourneyEvidence(evidence: SyntheticJourneyEvidence): void {
  const outputDir = path.resolve(process.cwd(), 'evidence', 'journeys');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  const filePath = path.join(outputDir, `${evidence.journey}.json`);
  fs.writeFileSync(filePath, JSON.stringify(evidence, null, 2), 'utf8');
}
