import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ZodError } from 'zod';

import { parseExecutiveScorecard, type ExecutiveScorecard } from '../scorecard/scorecard-schema.js';
import { createOpenAiProvider, DEFAULT_QE_AI_TIMEOUT_MS } from './openai-provider.js';
import {
  AiProviderUnavailableError,
  type AiAdvisoryUnavailableReason,
  type AiProvider,
} from './provider.js';
import {
  aiExecutiveScorecardSchema,
  parseAiExecutiveScorecard,
  type AiExecutiveScorecardAdvisory,
  type ExecutiveScorecardFinding,
} from './executive-scorecard-schema.js';

export const AI_EXECUTIVE_SCORECARD_UNAVAILABLE = 'AI_EXECUTIVE_SCORECARD_UNAVAILABLE' as const;
export const QE_EXECUTIVE_SCORECARD_PROMPT_VERSION = 'qe-executive-scorecard-v1' as const;

export const EXECUTIVE_SCORECARD_SYSTEM_INSTRUCTIONS = [
  'Você é uma camada consultiva de Quality Engineering que interpreta um scorecard determinístico [LAB] para liderança técnica.',
  'Escreva em português do Brasil, com linguagem executiva, direta e sem jargão desnecessário.',
  'Não recalcule indicadores e não contradiga status, tendências ou evidências fornecidos.',
  'Classifique cada finding como OBSERVED (direto no scorecard), INFERRED (hipótese sustentada por sinais) ou GAP (ausência de evidência).',
  'Cite a dimensão, risco, controle, indicador ou arquivo que sustenta cada finding.',
  'Não use as expressões: aprovado pela IA, reprovado pela IA, seguro para produção, pronto para release ou incidente evitado.',
  'Não atribua SLA real à TOTVS: os limites são exclusivamente sintéticos do laboratório.',
  'Não aprove nem reprove release; a decisão é exclusivamente humana.',
].join(' ');

export interface ExecutiveScorecardAdvisoryContext {
  purpose: 'executive-quality-scorecard-advisory';
  promptVersion: typeof QE_EXECUTIVE_SCORECARD_PROMPT_VERSION;
  guardrails: string[];
  scorecard: ExecutiveScorecard;
}

export type ExecutiveScorecardAdvisoryOutcome =
  | { status: 'AVAILABLE'; provider: string; model: string; advisory: AiExecutiveScorecardAdvisory }
  | { status: typeof AI_EXECUTIVE_SCORECARD_UNAVAILABLE; reason: AiAdvisoryUnavailableReason };

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new AiProviderUnavailableError('TIMEOUT_OR_PROVIDER_FAILURE', 'Executive scorecard advisory timed out')),
      timeoutMs,
    );
    operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

export function buildExecutiveScorecardAdvisoryContext(
  scorecardPath = process.env.QE_SCORECARD_PATH ?? path.resolve(process.cwd(), 'evidence', 'scorecard', 'current.json'),
): ExecutiveScorecardAdvisoryContext {
  const scorecard = parseExecutiveScorecard(JSON.parse(fs.readFileSync(scorecardPath, 'utf8')));
  return {
    purpose: 'executive-quality-scorecard-advisory',
    promptVersion: QE_EXECUTIVE_SCORECARD_PROMPT_VERSION,
    guardrails: [
      'scorecard-is-deterministic-source-of-truth',
      'no-metric-recalculation',
      'strict-finding-classification',
      'evidence-citation-required',
      'no-production-or-release-claims',
      'recommendations-only',
      'no-release-decision',
      'human-review-required',
    ],
    scorecard,
  };
}

export async function runExecutiveScorecardAdvisory(
  provider: AiProvider,
  context: ExecutiveScorecardAdvisoryContext,
  timeoutMs = DEFAULT_QE_AI_TIMEOUT_MS,
): Promise<ExecutiveScorecardAdvisoryOutcome> {
  try {
    const raw = await withTimeout(provider.analyze(context, {
      schema: aiExecutiveScorecardSchema,
      schemaName: 'qe_executive_scorecard_advisory',
      instructions: EXECUTIVE_SCORECARD_SYSTEM_INSTRUCTIONS,
      maxOutputTokens: 2_800,
    }), timeoutMs);
    return {
      status: 'AVAILABLE',
      provider: provider.name,
      model: provider.model,
      advisory: parseAiExecutiveScorecard(raw),
    };
  } catch (error) {
    if (error instanceof AiProviderUnavailableError) {
      return { status: AI_EXECUTIVE_SCORECARD_UNAVAILABLE, reason: error.reason };
    }
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return { status: AI_EXECUTIVE_SCORECARD_UNAVAILABLE, reason: 'INVALID_RESPONSE' };
    }
    return { status: AI_EXECUTIVE_SCORECARD_UNAVAILABLE, reason: 'TIMEOUT_OR_PROVIDER_FAILURE' };
  }
}

function findings(title: string, items: ExecutiveScorecardFinding[]): string[] {
  return [
    `### ${title}`,
    '',
    ...(items.length > 0
      ? items.map((item) => `- **${item.subject}** — \`[${item.classification}]\` ${item.rationale}. **Base da leitura:** ${item.evidence.join('; ')}.`)
      : ['- Nenhum ponto adicional sugerido.']),
    '',
  ];
}

export function formatExecutiveScorecardAdvisory(outcome: ExecutiveScorecardAdvisoryOutcome): string {
  if (outcome.status === AI_EXECUTIVE_SCORECARD_UNAVAILABLE) {
    return [
      '## Parecer Executivo Consultivo — AI-05',
      '',
      `**${AI_EXECUTIVE_SCORECARD_UNAVAILABLE}**`,
      '',
      'Parecer executivo de IA indisponível — Quality Gate não afetado.',
      '',
      `Motivo técnico: \`${outcome.reason}\`.`,
      '',
    ].join('\n');
  }

  const advisory = outcome.advisory;
  return [
    '## Parecer Executivo Consultivo — AI-05',
    '',
    '> [LAB] Leitura probabilística sobre evidências determinísticas. A decisão permanece humana.',
    '',
    `- Confiança: **${advisory.confidence}**`,
    `- Provedor: \`${outcome.provider}\` (modelo \`${outcome.model}\`, prompt \`${QE_EXECUTIVE_SCORECARD_PROMPT_VERSION}\`)`,
    '',
    '### Resumo Executivo',
    '',
    advisory.executiveSummary,
    '',
    ...findings('Interpretação geral', [advisory.overallInterpretation]),
    ...findings('Riscos afetados', advisory.affectedRisks),
    ...findings('Evidências mais fortes', advisory.strongestEvidence),
    ...findings('Regressões', advisory.regressions),
    ...findings('Jornadas degradadas', advisory.degradedJourneys),
    ...findings('Resiliência', advisory.resilienceFindings),
    ...findings('Observabilidade', advisory.observabilityFindings),
    ...findings('Desempenho', advisory.performanceFindings),
    ...findings('Lacunas de cobertura', advisory.coverageGaps),
    ...findings('Investigações recomendadas', advisory.recommendedInvestigations),
    ...findings('Testes recomendados', advisory.recommendedTests),
    ...findings('Perguntas para decisão humana', advisory.humanQuestions),
  ].join('\n');
}

async function main(): Promise<void> {
  try {
    const context = buildExecutiveScorecardAdvisoryContext();
    const outcome = await runExecutiveScorecardAdvisory(createOpenAiProvider(), context);
    process.stdout.write(`${formatExecutiveScorecardAdvisory(outcome)}\n`);
  } catch {
    process.stdout.write(`${formatExecutiveScorecardAdvisory({
      status: AI_EXECUTIVE_SCORECARD_UNAVAILABLE,
      reason: 'INVALID_RESPONSE',
    })}\n`);
  }
}

const executedFile = process.argv[1];
if (executedFile && import.meta.url === pathToFileURL(executedFile).href) {
  void main();
}
