import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildExecutiveScorecard,
  writeScorecardArtifacts,
  type ScorecardSignals,
} from '../../tools/scorecard/scorecard-builder.js';
import { parseExecutiveScorecard } from '../../tools/scorecard/scorecard-schema.js';
import { renderScorecardHtml } from '../../tools/scorecard/scorecard-renderer.js';
import {
  AI_EXECUTIVE_SCORECARD_UNAVAILABLE,
  buildExecutiveScorecardAdvisoryContext,
  runExecutiveScorecardAdvisory,
} from '../../tools/ai/executive-scorecard-intelligence.js';
import {
  parseAiExecutiveScorecard,
  type AiExecutiveScorecardAdvisory,
} from '../../tools/ai/executive-scorecard-schema.js';
import { createOpenAiProvider } from '../../tools/ai/openai-provider.js';
import { UnavailableAiProvider, type AiProvider } from '../../tools/ai/provider.js';

const riskControls = [
  { riskId: 'RISK-RES-001', controlId: 'CTRL-RES-001' },
  { riskId: 'RISK-OBS-001', controlId: 'CTRL-OBS-001' },
  { riskId: 'RISK-JOURNEY-001', controlId: 'CTRL-JOURNEY-001' },
  { riskId: 'RISK-PERF-001', controlId: 'CTRL-PERF-LATENCY-001' },
];

function greenSignals(): ScorecardSignals {
  return {
    riskControls,
    controlExecutions: [
      { ...riskControls[0]!, result: 'PASSED', source: 'res.json', kind: 'RESILIENCY' },
      { ...riskControls[1]!, result: 'PASSED', source: 'obs.json', kind: 'OBSERVABILITY' },
      { ...riskControls[2]!, result: 'PASSED', source: 'journey.json', kind: 'JOURNEY' },
      { ...riskControls[3]!, result: 'PASSED', source: 'current.json', kind: 'PERFORMANCE' },
    ],
    invalidEvidenceFiles: 0,
    sources: {
      riskMap: true,
      resiliency: true,
      observability: true,
      journeys: true,
      performanceCurrent: true,
      performanceBaseline: true,
    },
    journeys: {
      total: 1, passed: 1, failed: 0, slaMet: 1, slaBreached: 0,
      apiLatencyMaxMs: 30, endToEndMaxMs: 120,
    },
    resilience: {
      total: 1, passed: 1, failed: 0,
      recoveryMinMs: 40, recoveryAvgMs: 40, recoveryMaxMs: 40,
    },
    observability: {
      total: 1, passed: 1, failed: 0, traces: 1, errorTraces: 0, missingSpanScenarios: 0,
    },
    performance: {
      result: 'PASSED', p50Ms: 25, p95Ms: 150, p99Ms: 300, throughputRps: 20,
      errorRate: 0, duplicateResources: 0, duplicateOperations: 0, e2eP95Ms: 400,
      thresholdStatus: 'MET', comparisonStatus: 'STABLE', tolerancePct: 0.2, regressedMetrics: [],
    },
    hasHistoricalSeries: true,
    latestEvidenceAt: '2026-09-04T12:00:00.000Z',
  };
}

const metadata = { generatedAt: '2026-09-04T12:00:00.000Z', commit: 'abc123' };

test('regra determinística produz status GREEN quando todos os sinais estão completos e aprovados', () => {
  const scorecard = buildExecutiveScorecard(greenSignals(), metadata);
  assert.equal(scorecard.overallStatus, 'GREEN');
});

test('regra determinística produz status YELLOW para cobertura parcial relevante', () => {
  const signals = greenSignals();
  signals.controlExecutions = signals.controlExecutions.slice(0, 3);
  const scorecard = buildExecutiveScorecard(signals, metadata);
  assert.equal(scorecard.overallStatus, 'YELLOW');
  assert.equal(scorecard.dimensions.find((item) => item.key === 'CONTROLS')?.status, 'YELLOW');
});

test('regra determinística produz status RED quando um controle falha', () => {
  const signals = greenSignals();
  signals.controlExecutions[0] = { ...signals.controlExecutions[0]!, result: 'FAILED' };
  signals.resilience.failed = 1;
  signals.resilience.passed = 0;
  const scorecard = buildExecutiveScorecard(signals, metadata);
  assert.equal(scorecard.overallStatus, 'RED');
  assert.equal(scorecard.summary.controlsFailed, 1);
});

test('regra determinística produz UNKNOWN quando evidências operacionais estão indisponíveis', () => {
  const signals = greenSignals();
  signals.controlExecutions = [];
  signals.sources = Object.fromEntries(Object.keys(signals.sources).map((key) => [key, false])) as ScorecardSignals['sources'];
  signals.journeys = { total: 0, passed: 0, failed: 0, slaMet: 0, slaBreached: 0, apiLatencyMaxMs: 0, endToEndMaxMs: 0 };
  signals.resilience = { total: 0, passed: 0, failed: 0, recoveryMinMs: 0, recoveryAvgMs: 0, recoveryMaxMs: 0 };
  signals.observability = { total: 0, passed: 0, failed: 0, traces: 0, errorTraces: 0, missingSpanScenarios: 0 };
  signals.performance = { ...signals.performance, result: 'UNKNOWN', thresholdStatus: 'UNKNOWN', comparisonStatus: 'NO_BASELINE' };
  const scorecard = buildExecutiveScorecard(signals, metadata);
  assert.equal(scorecard.overallStatus, 'UNKNOWN');
});

test('risk coverage usa riscos conhecidos e riscos com controle evidenciado', () => {
  const signals = greenSignals();
  signals.controlExecutions = signals.controlExecutions.slice(0, 2);
  const scorecard = buildExecutiveScorecard(signals, metadata);
  assert.equal(scorecard.summary.riskCoveragePct, 50);
  assert.equal(scorecard.summary.exercisedRisks, 2);
});

test('violação de SLA sintético torna Critical Journeys RED', () => {
  const signals = greenSignals();
  signals.journeys.slaMet = 0;
  signals.journeys.slaBreached = 1;
  const scorecard = buildExecutiveScorecard(signals, metadata);
  assert.equal(scorecard.dimensions.find((item) => item.key === 'CRITICAL_JOURNEYS')?.status, 'RED');
});

test('regressão de performance torna Regression RED e tendência DEGRADING', () => {
  const signals = greenSignals();
  signals.performance.comparisonStatus = 'REGRESSED';
  signals.performance.regressedMetrics = ['p95'];
  const scorecard = buildExecutiveScorecard(signals, metadata);
  const regression = scorecard.dimensions.find((item) => item.key === 'REGRESSION');
  assert.equal(regression?.status, 'RED');
  assert.equal(regression?.trend, 'DEGRADING');
});

test('falha em jornada torna Critical Journeys e Overall RED', () => {
  const signals = greenSignals();
  signals.journeys.failed = 1;
  signals.journeys.passed = 0;
  const scorecard = buildExecutiveScorecard(signals, metadata);
  assert.equal(scorecard.overallStatus, 'RED');
});

test('evidência ausente é gap explícito e não aprovação implícita', () => {
  const signals = greenSignals();
  signals.sources.performanceBaseline = false;
  signals.performance.comparisonStatus = 'NO_BASELINE';
  const scorecard = buildExecutiveScorecard(signals, metadata);
  assert.ok(scorecard.knownGaps.some((item) => item.includes('performanceBaseline')));
  assert.equal(scorecard.dimensions.find((item) => item.key === 'REGRESSION')?.status, 'UNKNOWN');
});

test('gap de observabilidade resulta em YELLOW sem confundir ERROR simulado com falha do controle', () => {
  const signals = greenSignals();
  signals.observability.errorTraces = 1;
  signals.observability.missingSpanScenarios = 1;
  const scorecard = buildExecutiveScorecard(signals, metadata);
  assert.equal(scorecard.dimensions.find((item) => item.key === 'OBSERVABILITY')?.status, 'YELLOW');
});

test('tendência STABLE é preservada para comparação pontual estável', () => {
  const scorecard = buildExecutiveScorecard(greenSignals(), metadata);
  assert.equal(scorecard.overallTrend, 'STABLE');
});

test('tendência DEGRADING é preservada quando a baseline regride', () => {
  const signals = greenSignals();
  signals.performance.comparisonStatus = 'REGRESSED';
  assert.equal(buildExecutiveScorecard(signals, metadata).overallTrend, 'DEGRADING');
});

test('schema do scorecard aceita estrutura válida e rejeita status fora do enum', () => {
  const scorecard = buildExecutiveScorecard(greenSignals(), metadata);
  assert.equal(parseExecutiveScorecard(scorecard).schemaVersion, '1.0.0');
  assert.throws(() => parseExecutiveScorecard({ ...scorecard, overallStatus: 'BLUE' }));
});

test('HTML e PDF são gerados localmente com rodapé e conteúdo executivo', async () => {
  const scorecard = buildExecutiveScorecard(greenSignals(), metadata);
  const html = renderScorecardHtml(scorecard);
  assert.ok(html.includes('Decisão humana obrigatória'));
  assert.ok(html.includes('Quality Engineering Lab — NÃO OFICIAL'));

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qe-scorecard-'));
  try {
    const files = await writeScorecardArtifacts(scorecard, tempDir);
    const pdf = fs.readFileSync(path.join(tempDir, 'evidence', 'scorecard', 'executive-scorecard.pdf'));
    assert.equal(files.length, 4);
    assert.equal(pdf.subarray(0, 4).toString('ascii'), '%PDF');
    assert.ok(pdf.length > 5_000);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

const finding = {
  subject: 'Cobertura parcial',
  rationale: 'Há riscos sem evidência serializada nesta coleta',
  evidence: ['current.json: summary.controlsUnknown'],
  classification: 'OBSERVED' as const,
};

const validAiAdvisory: AiExecutiveScorecardAdvisory = {
  executiveSummary: 'O scorecard [LAB] apresenta evidências completas para as dimensões exercitadas e gaps explícitos.',
  overallInterpretation: finding,
  affectedRisks: [finding],
  strongestEvidence: [finding],
  regressions: [],
  degradedJourneys: [],
  resilienceFindings: [],
  observabilityFindings: [],
  performanceFindings: [],
  coverageGaps: [finding],
  recommendedInvestigations: [finding],
  recommendedTests: [finding],
  humanQuestions: [finding],
  confidence: 'HIGH',
};

test('schema de IA aceita advisory válido e rejeita classificação inválida', () => {
  assert.equal(parseAiExecutiveScorecard(validAiAdvisory).confidence, 'HIGH');
  assert.throws(() => parseAiExecutiveScorecard({
    ...validAiAdvisory,
    overallInterpretation: { ...finding, classification: 'CERTAIN' },
  }));
});

test('schema de IA rejeita linguagem proibida de decisão', () => {
  assert.throws(() => parseAiExecutiveScorecard({ ...validAiAdvisory, executiveSummary: 'Pronto para release.' }));
});

test('ausência de API key retorna AI_EXECUTIVE_SCORECARD_UNAVAILABLE', async () => {
  const scorecard = buildExecutiveScorecard(greenSignals(), metadata);
  const context = { purpose: 'executive-quality-scorecard-advisory' as const, promptVersion: 'qe-executive-scorecard-v1' as const, guardrails: [], scorecard };
  const outcome = await runExecutiveScorecardAdvisory(createOpenAiProvider({}), context);
  assert.equal(outcome.status, AI_EXECUTIVE_SCORECARD_UNAVAILABLE);
  if (outcome.status === AI_EXECUTIVE_SCORECARD_UNAVAILABLE) assert.equal(outcome.reason, 'MISSING_API_KEY');
});

test('falha simulada de provider não afeta o Quality Gate', async () => {
  const scorecard = buildExecutiveScorecard(greenSignals(), metadata);
  const context = { purpose: 'executive-quality-scorecard-advisory' as const, promptVersion: 'qe-executive-scorecard-v1' as const, guardrails: [], scorecard };
  const provider: AiProvider = { name: 'broken', model: 'mock', analyze: async () => { throw new Error('network'); } };
  const outcome = await runExecutiveScorecardAdvisory(provider, context);
  assert.equal(outcome.status, AI_EXECUTIVE_SCORECARD_UNAVAILABLE);
  if (outcome.status === AI_EXECUTIVE_SCORECARD_UNAVAILABLE) assert.equal(outcome.reason, 'TIMEOUT_OR_PROVIDER_FAILURE');
});

test('provider indisponível mantém fallback consultivo', async () => {
  const scorecard = buildExecutiveScorecard(greenSignals(), metadata);
  const context = { purpose: 'executive-quality-scorecard-advisory' as const, promptVersion: 'qe-executive-scorecard-v1' as const, guardrails: [], scorecard };
  const outcome = await runExecutiveScorecardAdvisory(new UnavailableAiProvider('PROVIDER_UNAVAILABLE'), context);
  assert.equal(outcome.status, AI_EXECUTIVE_SCORECARD_UNAVAILABLE);
});

test('contexto da IA lê somente o scorecard estruturado', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qe-ai-scorecard-'));
  try {
    const filePath = path.join(tempDir, 'current.json');
    fs.writeFileSync(filePath, JSON.stringify(buildExecutiveScorecard(greenSignals(), metadata)));
    const context = buildExecutiveScorecardAdvisoryContext(filePath);
    assert.equal(context.scorecard.decisionAuthority, 'HUMAN');
    assert.equal(context.purpose, 'executive-quality-scorecard-advisory');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
