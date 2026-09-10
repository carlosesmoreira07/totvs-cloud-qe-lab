import { z } from 'zod';

export const advisoryItemSchema = z.object({
  subject: z.string().min(1).max(200),
  rationale: z.string().min(1).max(300),
  evidence: z.array(z.string().min(1).max(300)).max(5),
}).strict();

export const aiAdvisorySchema = z.object({
  changeSummary: z.string().min(1).max(300),
  changeNature: z.enum(['DOCUMENTATION', 'FORMATTING', 'CONTRACT', 'BEHAVIOR', 'SECURITY', 'INFRASTRUCTURE', 'MIXED']),
  impact: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  attention: z.array(z.string().min(1).max(300)).max(3),
  actions: z.array(z.string().min(1).max(300)).max(3),
  humanQuestion: z.string().max(300).nullable(),
}).strict();

export type AiAdvisory = z.infer<typeof aiAdvisorySchema>;

export function parseAiAdvisory(value: unknown): AiAdvisory {
  return aiAdvisorySchema.parse(value);
}
