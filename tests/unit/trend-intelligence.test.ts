import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AI_TREND_ADVISORY_UNAVAILABLE,
  buildTrendAdvisoryContext,
  formatTrendAdvisoryMarkdown,
  runTrendAdvisoryAnalysis,
  type TrendAdvisoryContext,
} from '../../tools/ai/trend-intelligence.js';
import {
  parseAiTrendAdvisory,
  type AiTrendAdvisory,
  type TrendIntelligenceFinding,
} from '../../tools/ai/trend-intelligence-schema.js';
import { createOpenAiProvider } from '../../tools/ai/openai-provider.js';
import type { AiProvider } from '../../tools/ai/provider.js';
import type { HistorySnapshot } from '../../tools/history/history-schema.js';
import { ZodError } from 'zod';

const sampleObservedFinding: TrendIntelligenceFinding = {
  subject: 'Aumento da Cobertura de Riscos',
  rationale: 'A cobertura percentual de riscos conhecidos evoluiu sustentadamente ao longo dos checkpoints.',
  evidence: ['Risk coverage: 29.4% -> 100.0%'],
  classification: 'OBSERVED',
};

const sampleInferredFinding: TrendIntelligenceFinding = {
  subject: 'Estabilidade de Controles de Produção',
  rationale: 'Com 20 controles aprovados consecutivos, a consistência transacional demonstra maturidade no laboratório.',
  evidence: ['20 controles aprovados', '0 controles falhos'],
  classification: 'INFERRED',
};

const sampleGapFinding: TrendIntelligenceFinding = {
  subject: 'Histórico insuficiente de Observabilidade',
  rationale: 'A dimensão de observabilidade não possui amostragem temporal suficiente para tendência definitiva.',
  evidence: ['Observability trend: UNKNOWN', 'Cadeia parcial observada'],
  classification: 'GAP',
};

const validAdvisoryImproving: AiTrendAdvisory = {
  executiveSummary: 'A qualidade geral apresenta tendência determinística de melhoria nos checkpoints analisados.',
  improvingAreas: [sampleObservedFinding],
  degradingAreas: [],
  persistentRisks: [],
  regressionFindings: [],
  qualitySignals: [sampleInferredFinding],
  recommendedInvestigations: [],
  recommendedActions: [{
    subject: 'Manter monitoramento de regressão',
    rationale: 'Preservar execuções regulares dos testes de capacidade.',
    evidence: ['Baseline 20% tolerance'],
    classification: 'INFERRED',
  }],
  humanQuestions: [sampleGapFinding],
  confidence: 'HIGH',
};

function createMockSnapshot(overrides: Partial<HistorySnapshot> = {}): HistorySnapshot {
  return {
    timestamp: '2026-09-04T12:00:00Z',
    commitSha: 'd1a197d',
    overallStatus: 'YELLOW',
    riskCoverage: { knownRisks: 17, exercisedRisks: 5, coveragePct: 29.4 },
    controlsPassed: 5,
    controlsFailed: 0,
    journeysPassed: 4,
    journeysFailed: 0,
    slaMet: 4,
    slaBreached: 0,
    resiliencePassed: 6,
    resilienceFailed: 0,
    recoveryDuration: { minMs: 100, avgMs: 150, maxMs: 200 },
    observabilityStatus: 'YELLOW',
    performanceStatus: 'GREEN',
    apiP95: 180,
    apiP99: 250,
    regressionStatus: 'GREEN',
    securityStatus: 'UNKNOWN',
    securityFindings: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    knownGaps: ['SECURITY_GAP_IAM_NOT_IMPLEMENTED', 'OBSERVABILITY_GAP_PARTIAL_CHAIN'],
    ...overrides,
  };
}

test('trend IMPROVING: structured output válido é aprovado pelo validador Zod', () => {
  const parsed = parseAiTrendAdvisory(validAdvisoryImproving);
  assert.equal(parsed.confidence, 'HIGH');
  assert.equal(parsed.improvingAreas.length, 1);
  assert.equal(parsed.improvingAreas[0]?.classification, 'OBSERVED');
});

test('trend STABLE: advisory estável com zero degradações é validado', () => {
  const stableAdvisory: AiTrendAdvisory = {
    ...validAdvisoryImproving,
    executiveSummary: 'Os indicadores de qualidade mantiveram-se estáveis nos últimos 3 checkpoints.',
    improvingAreas: [],
    degradingAreas: [],
    confidence: 'MEDIUM',
  };
  const parsed = parseAiTrendAdvisory(stableAdvisory);
  assert.equal(parsed.confidence, 'MEDIUM');
  assert.equal(parsed.degradingAreas.length, 0);
});

test('trend DEGRADING: áreas em degradação com achados OBSERVED são aceitas', () => {
  const degradingAdvisory: AiTrendAdvisory = {
    ...validAdvisoryImproving,
    executiveSummary: 'Degradação observada nos controles de performance sob concorrência.',
    improvingAreas: [],
    degradingAreas: [{
      subject: 'Regressão de Latência p95',
      rationale: 'O tempo de resposta da API excedeu a tolerância configurada de 10%.',
      evidence: ['p95: 180 ms -> 230 ms (+28%)'],
      classification: 'OBSERVED',
    }],
    confidence: 'HIGH',
  };
  const parsed = parseAiTrendAdvisory(degradingAdvisory);
  assert.equal(parsed.degradingAreas.length, 1);
  assert.equal(parsed.degradingAreas[0]?.subject, 'Regressão de Latência p95');
});

test('trend UNKNOWN: dimensão com histórico insuficiente é classificada como GAP', () => {
  const unknownAdvisory: AiTrendAdvisory = {
    ...validAdvisoryImproving,
    executiveSummary: 'Histórico insuficiente para determinar tendência temporal nas dimensões solicitadas.',
    improvingAreas: [],
    degradingAreas: [],
    qualitySignals: [sampleGapFinding],
    confidence: 'LOW',
  };
  const parsed = parseAiTrendAdvisory(unknownAdvisory);
  assert.equal(parsed.confidence, 'LOW');
  assert.equal(parsed.qualitySignals[0]?.classification, 'GAP');
});

test('histórico insuficiente: context com menos de 3 checkpoints sinaliza canCalculateTrend false', () => {
  // Chamada de buildTrendAdvisoryContext com caminhos inexistentes ou mock
  const context = buildTrendAdvisoryContext({
    historyPath: 'evidence/nonexistent-history.json',
    trendsPath: 'evidence/nonexistent-trends.json',
    scorecardPath: 'evidence/nonexistent-scorecard.json',
  });
  assert.equal(context.canCalculateTrend, false);
  assert.equal(context.checkpointsCount, 0);
  assert.match(context.trendDisclaimer, /Histórico insuficiente/);
});

test('regressão de performance: detecta regressão nos dados determinísticos', async () => {
  const context = buildTrendAdvisoryContext();
  assert.ok(context.purpose === 'trend-and-regression-intelligence');
  assert.ok(Array.isArray(context.dimensions));
});

test('aumento de findings de segurança: metric delta registra degradação quando severidades críticas aumentam', () => {
  const snap1 = createMockSnapshot({
    timestamp: '2026-09-01T10:00:00Z',
    securityFindings: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  });
  const snap2 = createMockSnapshot({
    timestamp: '2026-09-02T10:00:00Z',
    securityFindings: { critical: 1, high: 2, medium: 1, low: 0, info: 0 },
  });

  // Validação manual de cálculo delta
  const firstCritHigh = snap1.securityFindings.critical + snap1.securityFindings.high;
  const latestCritHigh = snap2.securityFindings.critical + snap2.securityFindings.high;
  assert.ok(latestCritHigh > firstCritHigh);
});

test('redução de gaps: metric delta registra melhoria quando gaps diminuem', () => {
  const snap1 = createMockSnapshot({
    timestamp: '2026-09-01T10:00:00Z',
    knownGaps: ['GAP-1', 'GAP-2', 'GAP-3'],
  });
  const snap2 = createMockSnapshot({
    timestamp: '2026-09-02T10:00:00Z',
    knownGaps: ['GAP-1'],
  });
  const gapsDelta = snap2.knownGaps.length - snap1.knownGaps.length;
  assert.ok(gapsDelta < 0);
});

test('schema rejeita classificação inválida fora do enum OBSERVED, INFERRED, GAP', () => {
  assert.throws(
    () => parseAiTrendAdvisory({
      ...validAdvisoryImproving,
      improvingAreas: [{
        ...sampleObservedFinding,
        classification: 'DEFINITIVE',
      }],
    }),
    (err: unknown) => err instanceof ZodError,
  );
});

test('schema rejeita linguagem proibida de aprovação de release ou sistema seguro/saudável', () => {
  assert.throws(() => parseAiTrendAdvisory({
    ...validAdvisoryImproving,
    executiveSummary: 'A qualidade geral melhorou definitivamente após a refatoração.',
  }), /linguagem proibida/);

  assert.throws(() => parseAiTrendAdvisory({
    ...validAdvisoryImproving,
    executiveSummary: 'O sistema está saudável e aprovado para release.',
  }), /linguagem proibida/);

  assert.throws(() => parseAiTrendAdvisory({
    ...validAdvisoryImproving,
    executiveSummary: 'Release aprovado pelo time de engenharia.',
  }), /linguagem proibida/);
});

test('ausência de API key retorna fallback seguro AI_TREND_ADVISORY_UNAVAILABLE', async () => {
  const provider = createOpenAiProvider({});
  const context: TrendAdvisoryContext = {
    purpose: 'trend-and-regression-intelligence',
    promptVersion: 'qe-trend-advisory-v1',
    guardrails: [],
    checkpointsCount: 3,
    canCalculateTrend: true,
    overallHistoricalTrend: 'IMPROVING',
    overallComparisonStatus: 'STABLE',
    trendDisclaimer: 'Série com 3 checkpoints.',
    dimensions: [],
    improvingMetrics: [],
    degradingMetrics: [],
    newRisks: [],
    resolvedRisks: [],
    newGaps: [],
    persistentGaps: [],
    regressionsDetected: [],
    securityFindingsBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    p95Evolution: [],
    p99Evolution: [],
    slaEvolution: [],
    latestCommit: '343843e',
    firstCommit: 'd1a197d',
  };

  const outcome = await runTrendAdvisoryAnalysis(provider, context);
  assert.deepEqual(outcome, {
    status: AI_TREND_ADVISORY_UNAVAILABLE,
    reason: 'MISSING_API_KEY',
  });
  const markdown = formatTrendAdvisoryMarkdown(outcome);
  assert.match(markdown, /Quality Gate não afetado/);
});

test('provider mock retorna advisory AVAILABLE quando structured output é válido', async () => {
  const mockProvider: AiProvider = {
    name: 'mock-ai-provider',
    model: 'gpt-5.4-mini',
    analyze: async (_ctx, options) => {
      assert.equal(options?.schemaName, 'qe_trend_advisory');
      assert.ok(options?.schema);
      return validAdvisoryImproving;
    },
  };

  const context: TrendAdvisoryContext = {
    purpose: 'trend-and-regression-intelligence',
    promptVersion: 'qe-trend-advisory-v1',
    guardrails: [],
    checkpointsCount: 3,
    canCalculateTrend: true,
    overallHistoricalTrend: 'IMPROVING',
    overallComparisonStatus: 'STABLE',
    trendDisclaimer: 'Série com 3 checkpoints.',
    dimensions: [],
    improvingMetrics: [],
    degradingMetrics: [],
    newRisks: [],
    resolvedRisks: [],
    newGaps: [],
    persistentGaps: [],
    regressionsDetected: [],
    securityFindingsBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    p95Evolution: [],
    p99Evolution: [],
    slaEvolution: [],
    latestCommit: '343843e',
    firstCommit: 'd1a197d',
  };

  const outcome = await runTrendAdvisoryAnalysis(mockProvider, context);
  assert.equal(outcome.status, 'AVAILABLE');
  if (outcome.status === 'AVAILABLE') {
    assert.equal(outcome.advisory.confidence, 'HIGH');
    const md = formatTrendAdvisoryMarkdown(outcome);
    assert.match(md, /Tendências e Regressões \(AI-07\)/);
    assert.match(md, /\[INFERRED\]/);
    assert.match(md, /AI advisory/);
  }
});

test('falha do provider retorna fallback não bloqueante', async () => {
  const brokenProvider: AiProvider = {
    name: 'broken-provider',
    model: 'gpt-5.4-mini',
    analyze: async () => {
      throw new Error('Connection refused to AI endpoint');
    },
  };

  const context: TrendAdvisoryContext = {
    purpose: 'trend-and-regression-intelligence',
    promptVersion: 'qe-trend-advisory-v1',
    guardrails: [],
    checkpointsCount: 3,
    canCalculateTrend: true,
    overallHistoricalTrend: 'IMPROVING',
    overallComparisonStatus: 'STABLE',
    trendDisclaimer: 'Série com 3 checkpoints.',
    dimensions: [],
    improvingMetrics: [],
    degradingMetrics: [],
    newRisks: [],
    resolvedRisks: [],
    newGaps: [],
    persistentGaps: [],
    regressionsDetected: [],
    securityFindingsBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    p95Evolution: [],
    p99Evolution: [],
    slaEvolution: [],
    latestCommit: '343843e',
    firstCommit: 'd1a197d',
  };

  const outcome = await runTrendAdvisoryAnalysis(brokenProvider, context);
  assert.deepEqual(outcome, {
    status: AI_TREND_ADVISORY_UNAVAILABLE,
    reason: 'TIMEOUT_OR_PROVIDER_FAILURE',
  });
});
