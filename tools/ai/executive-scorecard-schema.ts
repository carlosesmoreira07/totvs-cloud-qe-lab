import { z } from 'zod';

export const executiveFindingClassificationSchema = z.enum(['OBSERVED', 'INFERRED', 'GAP']);

export const executiveScorecardFindingSchema = z.object({
  subject: z.string().min(1).max(200),
  rationale: z.string().min(1).max(500),
  evidence: z.array(z.string().min(1).max(300)).min(1).max(5),
  classification: executiveFindingClassificationSchema,
}).strict();

export const aiExecutiveScorecardSchema = z.object({
  executiveSummary: z.string().min(1).max(1_000),
  overallInterpretation: executiveScorecardFindingSchema,
  affectedRisks: z.array(executiveScorecardFindingSchema).max(20),
  strongestEvidence: z.array(executiveScorecardFindingSchema).max(20),
  regressions: z.array(executiveScorecardFindingSchema).max(20),
  degradedJourneys: z.array(executiveScorecardFindingSchema).max(20),
  resilienceFindings: z.array(executiveScorecardFindingSchema).max(20),
  observabilityFindings: z.array(executiveScorecardFindingSchema).max(20),
  performanceFindings: z.array(executiveScorecardFindingSchema).max(20),
  coverageGaps: z.array(executiveScorecardFindingSchema).max(20),
  recommendedInvestigations: z.array(executiveScorecardFindingSchema).max(20),
  recommendedTests: z.array(executiveScorecardFindingSchema).max(20),
  humanQuestions: z.array(executiveScorecardFindingSchema).max(20),
  confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']),
}).strict();

export type ExecutiveScorecardFinding = z.infer<typeof executiveScorecardFindingSchema>;
export type AiExecutiveScorecardAdvisory = z.infer<typeof aiExecutiveScorecardSchema>;

const PROHIBITED_CLAIMS = [
  'aprovado pela ia',
  'reprovado pela ia',
  'seguro para produção',
  'pronto para release',
  'incidente evitado',
] as const;

function textValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(textValues);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(textValues);
  return [];
}

export function parseAiExecutiveScorecard(value: unknown): AiExecutiveScorecardAdvisory {
  const parsed = aiExecutiveScorecardSchema.parse(value);
  const normalizedText = textValues(parsed).join(' ').toLocaleLowerCase('pt-BR');
  if (PROHIBITED_CLAIMS.some((claim) => normalizedText.includes(claim))) {
    throw new SyntaxError('A resposta contém linguagem de decisão proibida para uma camada consultiva.');
  }
  return parsed;
}
