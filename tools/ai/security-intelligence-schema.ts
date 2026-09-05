import { z } from 'zod';

export const securityIntelligenceClassificationSchema = z.enum(['OBSERVED', 'INFERRED', 'GAP']);

export const securityIntelligenceFindingSchema = z.object({
  subject: z.string().min(1).max(200),
  rationale: z.string().min(1).max(500),
  evidence: z.array(z.string().min(1).max(300)).min(1).max(5),
  classification: securityIntelligenceClassificationSchema,
}).strict();

export const aiSecurityAdvisorySchema = z.object({
  executiveSummary: z.string().min(1).max(1_000),
  topSecurityPriorities: z.array(securityIntelligenceFindingSchema).max(20),
  businessImpact: z.array(securityIntelligenceFindingSchema).max(20),
  technicalFindings: z.array(securityIntelligenceFindingSchema).max(20),
  affectedJourneys: z.array(securityIntelligenceFindingSchema).max(20),
  securityGaps: z.array(securityIntelligenceFindingSchema).max(20),
  recommendedInvestigations: z.array(securityIntelligenceFindingSchema).max(20),
  recommendedActions: z.array(securityIntelligenceFindingSchema).max(20),
  humanQuestions: z.array(securityIntelligenceFindingSchema).max(20),
  confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']),
}).strict();

export type SecurityIntelligenceFinding = z.infer<typeof securityIntelligenceFindingSchema>;
export type AiSecurityAdvisory = z.infer<typeof aiSecurityAdvisorySchema>;

const PROHIBITED_CLAIMS = [
  'o sistema esta seguro',
  'nao ha vulnerabilidades',
  'release aprovado',
  'release aprovada',
  'aprovado para release',
  'explore esta vulnerabilidade',
  'explorar esta vulnerabilidade',
  'execute o exploit',
  'obtenha acesso nao autorizado',
  'corrigido automaticamente',
] as const;

function textValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(textValues);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(textValues);
  return [];
}

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR');
}

export function parseAiSecurityAdvisory(value: unknown): AiSecurityAdvisory {
  const parsed = aiSecurityAdvisorySchema.parse(value);
  const normalizedText = normalizeText(textValues(parsed).join(' '));
  if (PROHIBITED_CLAIMS.some((claim) => normalizedText.includes(claim))) {
    throw new SyntaxError('A resposta contém linguagem proibida para Security Intelligence consultiva.');
  }
  return parsed;
}
