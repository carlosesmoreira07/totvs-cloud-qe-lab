import { z } from 'zod';

export const journeyFindingClassificationEnum = z.enum([
  'OBSERVED',
  'INFERRED',
  'GAP',
]);

export type JourneyFindingClassification = z.infer<typeof journeyFindingClassificationEnum>;

export const journeyFindingItemSchema = z.object({
  subject: z.string().min(1).max(200),
  rationale: z.string().min(1).max(500),
  evidence: z.array(z.string().min(1).max(300)).min(1).max(5),
  classification: journeyFindingClassificationEnum,
}).strict();

export type JourneyFindingItem = z.infer<typeof journeyFindingItemSchema>;

export const aiJourneyAdvisorySchema = z.object({
  executiveSummary: z.string().min(1).max(1000),
  degradedJourneys: z.array(journeyFindingItemSchema).max(20),
  slaFindings: z.array(journeyFindingItemSchema).max(20),
  probableBottlenecks: z.array(journeyFindingItemSchema).max(20),
  affectedRisks: z.array(journeyFindingItemSchema).max(20),
  traceCorrelations: z.array(journeyFindingItemSchema).max(20),
  resilienceCorrelations: z.array(journeyFindingItemSchema).max(20),
  coverageGaps: z.array(journeyFindingItemSchema).max(20),
  recommendedInvestigations: z.array(journeyFindingItemSchema).max(20),
  recommendedTests: z.array(journeyFindingItemSchema).max(20),
  humanQuestions: z.array(journeyFindingItemSchema).max(20),
  confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']),
}).strict();

export type AiJourneyAdvisory = z.infer<typeof aiJourneyAdvisorySchema>;

export function parseAiJourneyAdvisory(value: unknown): AiJourneyAdvisory {
  return aiJourneyAdvisorySchema.parse(value);
}
