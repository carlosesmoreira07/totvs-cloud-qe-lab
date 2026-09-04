import { z } from 'zod';
import { advisoryItemSchema } from './schema.js';

export const recoveryAssessmentEnum = z.enum([
  'RECOVERED_CONSISTENT',
  'RECOVERED_DEGRADED',
  'RECOVERY_FAILED',
  'INCONCLUSIVE',
]);

export type RecoveryAssessment = z.infer<typeof recoveryAssessmentEnum>;

export const aiFailureAdvisorySchema = z.object({
  failureSummary: z.string().min(1).max(1000),
  affectedRisks: z.array(advisoryItemSchema).max(20),
  recoveryAssessment: recoveryAssessmentEnum,
  consistencyConcerns: z.array(advisoryItemSchema).max(20),
  recurringPatterns: z.array(advisoryItemSchema).max(20),
  coverageGaps: z.array(advisoryItemSchema).max(20),
  recommendedExperiments: z.array(advisoryItemSchema).max(20),
  humanQuestions: z.array(advisoryItemSchema).max(20),
  confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']),
}).strict();

export type AiFailureAdvisory = z.infer<typeof aiFailureAdvisorySchema>;

export function parseAiFailureAdvisory(value: unknown): AiFailureAdvisory {
  return aiFailureAdvisorySchema.parse(value);
}
