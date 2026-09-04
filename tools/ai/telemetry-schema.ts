import { z } from 'zod';

export const findingClassificationEnum = z.enum([
  'OBSERVED',
  'INFERRED',
  'GAP',
]);

export type FindingClassification = z.infer<typeof findingClassificationEnum>;

export const telemetryFindingItemSchema = z.object({
  subject: z.string().min(1).max(200),
  rationale: z.string().min(1).max(500),
  evidence: z.array(z.string().min(1).max(300)).min(1).max(5),
  classification: findingClassificationEnum,
}).strict();

export type TelemetryFindingItem = z.infer<typeof telemetryFindingItemSchema>;

export const aiTelemetryAdvisorySchema = z.object({
  executiveSummary: z.string().min(1).max(1000),
  probableDegradationPoints: z.array(telemetryFindingItemSchema).max(20),
  affectedRisks: z.array(telemetryFindingItemSchema).max(20),
  traceFindings: z.array(telemetryFindingItemSchema).max(20),
  metricFindings: z.array(telemetryFindingItemSchema).max(20),
  instrumentationGaps: z.array(telemetryFindingItemSchema).max(20),
  consistencyConcerns: z.array(telemetryFindingItemSchema).max(20),
  recommendedInvestigations: z.array(telemetryFindingItemSchema).max(20),
  recommendedTests: z.array(telemetryFindingItemSchema).max(20),
  humanQuestions: z.array(telemetryFindingItemSchema).max(20),
  confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']),
}).strict();

export type AiTelemetryAdvisory = z.infer<typeof aiTelemetryAdvisorySchema>;

export function parseAiTelemetryAdvisory(value: unknown): AiTelemetryAdvisory {
  return aiTelemetryAdvisorySchema.parse(value);
}
