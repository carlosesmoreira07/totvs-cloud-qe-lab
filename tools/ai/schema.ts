import { z } from 'zod';

export const advisoryItemSchema = z.object({
  subject: z.string().min(1).max(200),
  rationale: z.string().min(1).max(500),
  evidence: z.array(z.string().min(1).max(300)).max(5),
}).strict();

export const aiAdvisorySchema = z.object({
  impact: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  impactedRisks: z.array(advisoryItemSchema).max(20),
  impactedControls: z.array(advisoryItemSchema).max(20),
  coverageGaps: z.array(advisoryItemSchema).max(20),
  suspiciousTests: z.array(advisoryItemSchema).max(20),
  securityConcerns: z.array(advisoryItemSchema).max(20),
  recommendedChecks: z.array(advisoryItemSchema).max(20),
  humanQuestions: z.array(advisoryItemSchema).max(20),
  confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']),
}).strict();

export type AiAdvisory = z.infer<typeof aiAdvisorySchema>;

export function parseAiAdvisory(value: unknown): AiAdvisory {
  return aiAdvisorySchema.parse(value);
}
