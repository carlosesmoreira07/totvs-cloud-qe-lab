import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  buildExecutiveScorecard,
  loadScorecardSignals,
  type ScorecardSignals,
} from '../scorecard/scorecard-builder.js';
import { parseSecuritySummary, type SecuritySummary } from '../security/security-schema.js';
import {
  historySnapshotSchema,
  type HistorySnapshot,
} from './history-schema.js';

export interface SnapshotOptions {
  repositoryRoot?: string;
  timestamp?: string;
  commitSha?: string;
}

function resolveCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function readSecuritySummary(repositoryRoot: string): SecuritySummary | null {
  const summaryPath = path.join(repositoryRoot, 'evidence', 'security', 'summary.json');
  try {
    const raw = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    return parseSecuritySummary(raw);
  } catch {
    return null;
  }
}

export function captureHistorySnapshot(
  signals?: ScorecardSignals,
  options: SnapshotOptions = {},
): HistorySnapshot {
  const repoRoot = options.repositoryRoot ?? process.cwd();
  const actualSignals = signals ?? loadScorecardSignals(repoRoot);
  const metadata: { generatedAt?: string; commit?: string } = {};
  if (options.timestamp) metadata.generatedAt = options.timestamp;
  if (options.commitSha) metadata.commit = options.commitSha;
  const scorecard = buildExecutiveScorecard(actualSignals, metadata);
  const security = readSecuritySummary(repoRoot);

  const timestamp = options.timestamp ?? process.env.QE_HISTORY_SNAPSHOT_TIMESTAMP ?? new Date().toISOString();
  const commitSha = options.commitSha ?? process.env.QE_HISTORY_SNAPSHOT_COMMIT ?? resolveCommit();

  const snapshot: HistorySnapshot = {
    timestamp,
    commitSha,
    overallStatus: scorecard.overallStatus,
    riskCoverage: {
      knownRisks: scorecard.summary.knownRisks,
      exercisedRisks: scorecard.summary.exercisedRisks,
      coveragePct: scorecard.summary.riskCoveragePct,
    },
    controlsPassed: scorecard.summary.controlsPassed,
    controlsFailed: scorecard.summary.controlsFailed,
    journeysPassed: scorecard.summary.journeysPassed,
    journeysFailed: scorecard.summary.journeysTotal - scorecard.summary.journeysPassed,
    slaMet: scorecard.summary.syntheticSlaMet,
    slaBreached: scorecard.summary.syntheticSlaTotal - scorecard.summary.syntheticSlaMet,
    resiliencePassed: actualSignals.resilience.passed,
    resilienceFailed: actualSignals.resilience.failed,
    recoveryDuration: {
      minMs: actualSignals.resilience.recoveryMinMs,
      avgMs: actualSignals.resilience.recoveryAvgMs,
      maxMs: actualSignals.resilience.recoveryMaxMs,
    },
    observabilityStatus: actualSignals.observability.total === 0
      ? 'UNKNOWN'
      : actualSignals.observability.failed > 0
        ? 'RED'
        : actualSignals.observability.missingSpanScenarios > 0
          ? 'YELLOW'
          : 'GREEN',
    performanceStatus: actualSignals.performance.result === 'UNKNOWN'
      ? 'UNKNOWN'
      : actualSignals.performance.result === 'FAILED' || actualSignals.performance.thresholdStatus === 'BREACHED'
        ? 'RED'
        : 'GREEN',
    apiP95: actualSignals.performance.p95Ms,
    apiP99: actualSignals.performance.p99Ms,
    regressionStatus: actualSignals.performance.comparisonStatus === 'NO_BASELINE'
      ? 'UNKNOWN'
      : actualSignals.performance.comparisonStatus === 'REGRESSED'
        ? 'RED'
        : 'GREEN',
    securityStatus: actualSignals.security.status,
    securityFindings: {
      critical: security?.metrics.openSeverities.CRITICAL ?? actualSignals.security.openCritical,
      high: security?.metrics.openSeverities.HIGH ?? actualSignals.security.openHigh,
      medium: security?.metrics.openSeverities.MEDIUM ?? 0,
      low: security?.metrics.openSeverities.LOW ?? 0,
      info: security?.metrics.openSeverities.INFO ?? 0,
    },
    knownGaps: scorecard.knownGaps,
  };

  return historySnapshotSchema.parse(snapshot);
}

export function writeSnapshotFile(
  snapshot: HistorySnapshot,
  repositoryRoot = process.cwd(),
): string {
  const snapshotsDir = path.join(repositoryRoot, 'evidence', 'history', 'snapshots');
  fs.mkdirSync(snapshotsDir, { recursive: true });

  const safeTime = snapshot.timestamp.replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
  const filename = `snapshot-${safeTime}-${snapshot.commitSha.slice(0, 7)}.json`;
  const targetPath = path.join(snapshotsDir, filename);

  fs.writeFileSync(targetPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  return targetPath;
}

async function main(): Promise<void> {
  const snapshot = captureHistorySnapshot();
  const filePath = writeSnapshotFile(snapshot);
  process.stdout.write(`Snapshot de qualidade registrado com sucesso: ${path.relative(process.cwd(), filePath)}\n`);
}

const executedFile = process.argv[1];
if (executedFile && import.meta.url === pathToFileURL(executedFile).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`Falha ao registrar snapshot: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
