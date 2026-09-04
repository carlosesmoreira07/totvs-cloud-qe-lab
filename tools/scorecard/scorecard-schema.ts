import { z } from 'zod';

export const qualityStatusSchema = z.enum(['GREEN', 'YELLOW', 'RED', 'UNKNOWN']);
export const qualityTrendSchema = z.enum(['IMPROVING', 'STABLE', 'DEGRADING', 'UNKNOWN']);

export const evidenceReferenceSchema = z.object({
  source: z.string().min(1),
  kind: z.enum(['RISK_MAP', 'RESILIENCY', 'OBSERVABILITY', 'JOURNEY', 'PERFORMANCE', 'BASELINE']),
  result: z.string().min(1),
}).strict();

export const scorecardIndicatorSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  value: z.union([z.string(), z.number()]),
  unit: z.string().min(1).optional(),
  status: qualityStatusSchema,
}).strict();

export const scorecardDimensionSchema = z.object({
  key: z.enum([
    'OVERALL_QUALITY',
    'RISK_COVERAGE',
    'CONTROLS',
    'CRITICAL_JOURNEYS',
    'RESILIENCE',
    'OBSERVABILITY',
    'PERFORMANCE',
    'REGRESSION',
    'KNOWN_GAPS',
  ]),
  label: z.string().min(1),
  status: qualityStatusSchema,
  trend: qualityTrendSchema,
  evidence: z.array(evidenceReferenceSchema),
  indicators: z.array(scorecardIndicatorSchema),
  explanation: z.string().min(1),
  risks: z.array(z.string().min(1)),
}).strict();

export const executiveScorecardSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  rulesVersion: z.literal('scorecard-rules-v1'),
  generatedAt: z.string().datetime(),
  commit: z.string().min(1),
  scope: z.literal('[LAB] Cloud Control Plane fictício'),
  decisionAuthority: z.literal('HUMAN'),
  overallStatus: qualityStatusSchema,
  overallTrend: qualityTrendSchema,
  summary: z.object({
    knownRisks: z.number().int().nonnegative(),
    exercisedRisks: z.number().int().nonnegative(),
    riskCoveragePct: z.number().min(0).max(100),
    controlsPassed: z.number().int().nonnegative(),
    controlsFailed: z.number().int().nonnegative(),
    controlsUnknown: z.number().int().nonnegative(),
    journeysPassed: z.number().int().nonnegative(),
    journeysTotal: z.number().int().nonnegative(),
    syntheticSlaMet: z.number().int().nonnegative(),
    syntheticSlaTotal: z.number().int().nonnegative(),
    knownGapCount: z.number().int().nonnegative(),
  }).strict(),
  dimensions: z.array(scorecardDimensionSchema).length(9),
  knownGaps: z.array(z.string().min(1)),
  trendDisclaimer: z.literal('Comparação pontual entre baseline e execução atual; não constitui série histórica.'),
  syntheticSlaDisclaimer: z.literal('SLAs sintéticos do laboratório não representam SLA real da TOTVS.'),
}).strict();

export type QualityStatus = z.infer<typeof qualityStatusSchema>;
export type QualityTrend = z.infer<typeof qualityTrendSchema>;
export type ScorecardIndicator = z.infer<typeof scorecardIndicatorSchema>;
export type ScorecardDimension = z.infer<typeof scorecardDimensionSchema>;
export type ExecutiveScorecard = z.infer<typeof executiveScorecardSchema>;

export function parseExecutiveScorecard(value: unknown): ExecutiveScorecard {
  return executiveScorecardSchema.parse(value);
}
