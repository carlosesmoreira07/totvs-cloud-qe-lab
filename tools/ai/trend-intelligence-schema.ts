import { z } from 'zod';

export const trendIntelligenceClassificationSchema = z.enum(['OBSERVED', 'INFERRED', 'GAP']);

export const trendIntelligenceFindingSchema = z.object({
  subject: z.string().min(1).max(200),
  rationale: z.string().min(1).max(500),
  evidence: z.array(z.string().min(1).max(300)).min(1).max(5),
  classification: trendIntelligenceClassificationSchema,
}).strict();

export const aiTrendAdvisorySchema = z.object({
  executiveSummary: z.string().min(1).max(1_000),
  improvingAreas: z.array(trendIntelligenceFindingSchema).max(20),
  degradingAreas: z.array(trendIntelligenceFindingSchema).max(20),
  persistentRisks: z.array(trendIntelligenceFindingSchema).max(20),
  regressionFindings: z.array(trendIntelligenceFindingSchema).max(20),
  qualitySignals: z.array(trendIntelligenceFindingSchema).max(20),
  recommendedInvestigations: z.array(trendIntelligenceFindingSchema).max(20),
  recommendedActions: z.array(trendIntelligenceFindingSchema).max(20),
  humanQuestions: z.array(trendIntelligenceFindingSchema).max(20),
  confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']),
}).strict();

export type TrendIntelligenceClassification = z.infer<typeof trendIntelligenceClassificationSchema>;
export type TrendIntelligenceFinding = z.infer<typeof trendIntelligenceFindingSchema>;
export type AiTrendAdvisory = z.infer<typeof aiTrendAdvisorySchema>;

const PROHIBITED_CLAIMS = [
  'a qualidade geral melhorou definitivamente',
  'o sistema esta saudavel',
  'o sistema esta seguro',
  'release aprovado',
  'release aprovada',
  'aprovado para release',
  'aprovado pela ia',
  'reprovado pela ia',
  'seguro para producao',
  'pronto para release',
  'corrigido automaticamente',
  'incidente evitado',
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

export function parseAiTrendAdvisory(value: unknown): AiTrendAdvisory {
  const parsed = aiTrendAdvisorySchema.parse(value);
  const normalizedText = normalizeText(textValues(parsed).join(' '));
  if (PROHIBITED_CLAIMS.some((claim) => normalizedText.includes(claim))) {
    throw new SyntaxError('A resposta contém linguagem proibida para Trend & Regression Intelligence consultiva.');
  }
  return parsed;
}
