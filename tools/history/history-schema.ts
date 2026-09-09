import { z } from 'zod';
import { qualityStatusSchema, qualityTrendSchema } from '../scorecard/scorecard-schema.js';

export const comparisonStatusSchema = z.enum([
  'IMPROVED',
  'STABLE',
  'REGRESSED',
  'NO_PREVIOUS_CHECKPOINT',
  'UNKNOWN',
]);

export const dimensionKeySchema = z.enum([
  'OVERALL_QUALITY',
  'RISK_COVERAGE',
  'CONTROLS',
  'CRITICAL_JOURNEYS',
  'RESILIENCE',
  'OBSERVABILITY',
  'PERFORMANCE',
  'REGRESSION',
  'SECURITY',
  'KNOWN_GAPS',
]);

export const historySnapshotSchema = z.object({
  timestamp: z.string().datetime(),
  commitSha: z.string().min(1),
  overallStatus: qualityStatusSchema,
  riskCoverage: z.object({
    knownRisks: z.number().int().nonnegative(),
    exercisedRisks: z.number().int().nonnegative(),
    coveragePct: z.number().min(0).max(100),
  }).strict(),
  controlsPassed: z.number().int().nonnegative(),
  controlsFailed: z.number().int().nonnegative(),
  journeysPassed: z.number().int().nonnegative(),
  journeysFailed: z.number().int().nonnegative(),
  slaMet: z.number().int().nonnegative(),
  slaBreached: z.number().int().nonnegative(),
  resiliencePassed: z.number().int().nonnegative(),
  resilienceFailed: z.number().int().nonnegative(),
  recoveryDuration: z.object({
    minMs: z.number().nonnegative(),
    avgMs: z.number().nonnegative(),
    maxMs: z.number().nonnegative(),
  }).strict(),
  observabilityStatus: qualityStatusSchema,
  performanceStatus: qualityStatusSchema,
  apiP95: z.number().nullable(),
  apiP99: z.number().nullable(),
  regressionStatus: qualityStatusSchema,
  securityStatus: qualityStatusSchema,
  securityFindings: z.object({
    critical: z.number().int().nonnegative(),
    high: z.number().int().nonnegative(),
    medium: z.number().int().nonnegative(),
    low: z.number().int().nonnegative(),
    info: z.number().int().nonnegative(),
  }).strict(),
  knownGaps: z.array(z.string().min(1)),
}).strict();

export const historyFileSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  generatedAt: z.string().datetime(),
  totalSnapshots: z.number().int().nonnegative(),
  snapshots: z.array(historySnapshotSchema),
}).strict();

export const dimensionTrendEvaluationSchema = z.object({
  dimension: dimensionKeySchema,
  label: z.string().min(1),
  historicalTrend: qualityTrendSchema,
  comparisonStatus: comparisonStatusSchema,
  latestStatus: qualityStatusSchema,
  interpretation: z.string().min(1),
  dataPoints: z.array(z.number().nullable()),
}).strict();

export const trendsFileSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  generatedAt: z.string().datetime(),
  checkpointsAnalyzed: z.number().int().nonnegative(),
  canCalculateTrend: z.boolean(),
  comparisonStatus: comparisonStatusSchema,
  overallTrend: qualityTrendSchema,
  dimensions: z.array(dimensionTrendEvaluationSchema),
  disclaimer: z.string().min(1),
}).strict();

export type ComparisonStatus = z.infer<typeof comparisonStatusSchema>;
export type DimensionKey = z.infer<typeof dimensionKeySchema>;
export type HistorySnapshot = z.infer<typeof historySnapshotSchema>;
export type HistoryFile = z.infer<typeof historyFileSchema>;
export type DimensionTrendEvaluation = z.infer<typeof dimensionTrendEvaluationSchema>;
export type TrendsFile = z.infer<typeof trendsFileSchema>;

export function parseHistorySnapshot(value: unknown): HistorySnapshot {
  return historySnapshotSchema.parse(value);
}

export function parseHistoryFile(value: unknown): HistoryFile {
  return historyFileSchema.parse(value);
}

export function parseTrendsFile(value: unknown): TrendsFile {
  return trendsFileSchema.parse(value);
}
