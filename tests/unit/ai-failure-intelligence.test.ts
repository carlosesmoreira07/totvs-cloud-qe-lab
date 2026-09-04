import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  computeResiliencyMetrics,
  loadResiliencyData,
  normalizeEvidence,
  type NormalizedResiliencyEvidence,
} from '../../tools/ai/evidence-loader.js';
import {
  AI_FAILURE_ADVISORY_UNAVAILABLE,
  buildFailureAdvisoryContext,
  formatFailureAdvisorySummary,
  runFailureAdvisoryAnalysis,
  type FailureAdvisoryContext,
} from '../../tools/ai/failure-intelligence.js';
import {
  aiFailureAdvisorySchema,
  parseAiFailureAdvisory,
  type AiFailureAdvisory,
} from '../../tools/ai/failure-schema.js';
import { createOpenAiProvider, OpenAiProvider } from '../../tools/ai/openai-provider.js';
import { UnavailableAiProvider, type AiProvider } from '../../tools/ai/provider.js';

const validFailureAdvisory: AiFailureAdvisory = {
  failureSummary: 'Os 6 cenários de falha recuperaram o estado final esperado de forma consistente.',
  affectedRisks: [
    {
      subject: 'RISK-RES-001',
      rationale: 'Indisponibilidade de broker reteve evento no Outbox com retry posterior bem-sucedido',
      evidence: ['nats-outage-during-publish.json'],
    },
  ],
  recoveryAssessment: 'RECOVERED_CONSISTENT',
  consistencyConcerns: [],
  recurringPatterns: [
    {
      subject: 'Recuperação com delay previsível',
      rationale: 'O tempo de restabelecimento do túnel foi inferior a 100ms em todas as execuções',
      evidence: ['durationMs < 100'],
    },
  ],
  coverageGaps: [
    {
      subject: 'Partição de rede bidirecional prolongada',
      rationale: 'O teste atual desabilita o broker apenas durante a publicação e não cobre expiração de timeout superior a 10 minutos',
      evidence: ['failure-recovery.spec.ts'],
    },
  ],
  recommendedExperiments: [
    {
      subject: 'Injetar latência variável via Toxiproxy',
      rationale: 'Avaliar o comportamento com jitter antes de perda total de pacotes',
      evidence: ['CTRL-RES-NATS-OUTAGE-001'],
    },
  ],
  humanQuestions: [
    {
      subject: 'Qual o SLA de retenção máxima de Outbox em PENDING?',
      rationale: 'Necessário para dimensionar alertas em caso de partição prolongada',
      evidence: ['docs/05-outbox-nats.md'],
    },
  ],
  confidence: 'HIGH',
};

const sampleEvidence: NormalizedResiliencyEvidence = {
  scenario: 'nats-outage-during-publish',
  riskId: 'RISK-RES-001',
  controlId: 'CTRL-RES-NATS-OUTAGE-001',
  observedFailure: 'SIMULATED_PUBLISH_FAILURE',
  startedAt: '2026-09-04T05:09:46.458Z',
  recoveredAt: '2026-09-04T05:09:46.515Z',
  durationMs: 57,
  finalState: {
    operationStatus: 'SUCCEEDED',
    instanceStatus: 'RUNNING',
    outboxStatus: 'PUBLISHED',
  },
  result: 'PASSED',
};

function createSampleContext(): FailureAdvisoryContext {
  return {
    purpose: 'failure-intelligence-advisory',
    promptVersion: 'qe-failure-advisory-v1',
    guardrails: ['no-release-decision', 'differentiate-evidence-vs-inference'],
    changes: {
      generatedBy: 'deterministic-impact-context',
      decisionAuthority: 'human',
      changedFiles: ['apps/control-plane-mock/src/consumer.ts'],
      candidateRisks: ['duplicidade'],
      candidateControls: ['npm run test:resiliency'],
      humanQuestions: [],
      knownRiskControls: [],
      relevantDiffs: [],
      openApiChanged: false,
      openApiDiff: null,
      limits: {
        maxDiffFiles: 12,
        maxCharsPerFile: 2800,
        maxTotalDiffChars: 16000,
        excludedSensitiveFileCount: 0,
      },
    },
    controlResults: {
      source: 'playwright-json',
      total: 6,
      passed: 6,
      failed: 0,
      flaky: 0,
      skipped: 0,
      durationMs: 4500,
      controls: [{ name: 'Cenário 1: NATS indisponível', status: 'passed' }],
    },
    resiliencyMetrics: computeResiliencyMetrics([sampleEvidence]),
    resiliencyEvidences: [sampleEvidence],
  };
}

test('leitura válida de evidência normaliza campos obrigatórios', () => {
  const normalized = normalizeEvidence(sampleEvidence);
  assert.ok(normalized);
  assert.equal(normalized.scenario, 'nats-outage-during-publish');
  assert.equal(normalized.riskId, 'RISK-RES-001');
  assert.equal(normalized.controlId, 'CTRL-RES-NATS-OUTAGE-001');
  assert.equal(normalized.result, 'PASSED');
  assert.equal(normalized.durationMs, 57);
});

test('ignora evidência com campos essenciais ausentes ou não-objeto', () => {
  assert.equal(normalizeEvidence(null), null);
  assert.equal(normalizeEvidence({}), null);
  assert.equal(normalizeEvidence({ scenario: 'test' }), null);
  assert.equal(normalizeEvidence({ scenario: 'test', riskId: 'R1' }), null);
});

test('lida com JSON inválido e arquivos malformados sem quebrar', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qe-test-invalid-json-'));
  try {
    fs.writeFileSync(path.join(tempDir, 'corrupt.json'), '{ "scenario": invalid json content');
    fs.writeFileSync(path.join(tempDir, 'valid.json'), JSON.stringify(sampleEvidence));

    const data = loadResiliencyData(tempDir);
    assert.equal(data.evidences.length, 1);
    assert.equal(data.invalidFileCount, 1);
    assert.equal(data.evidences[0]?.scenario, 'nats-outage-during-publish');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('diretório vazio retorna métricas zeradas', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qe-test-empty-'));
  try {
    const data = loadResiliencyData(tempDir);
    assert.equal(data.evidences.length, 0);
    assert.equal(data.invalidFileCount, 0);
    assert.equal(data.metrics.totalScenarios, 0);
    assert.equal(data.metrics.passed, 0);
    assert.equal(data.metrics.failed, 0);
    assert.equal(data.metrics.durationMs.avg, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('agregação de métricas calcula min/max/avg e união de riscos e falhas', () => {
  const evidences: NormalizedResiliencyEvidence[] = [
    {
      ...sampleEvidence,
      scenario: 'sc-1',
      durationMs: 40,
      riskId: 'RISK-RES-001',
      observedFailure: 'FAIL_A',
      result: 'PASSED',
    },
    {
      ...sampleEvidence,
      scenario: 'sc-2',
      durationMs: 100,
      riskId: 'RISK-RES-002',
      observedFailure: 'FAIL_B',
      result: 'PASSED',
    },
    {
      ...sampleEvidence,
      scenario: 'sc-3',
      durationMs: 70,
      riskId: 'RISK-RES-001',
      observedFailure: 'FAIL_A',
      result: 'FAILED',
    },
  ];

  const metrics = computeResiliencyMetrics(evidences);
  assert.equal(metrics.totalScenarios, 3);
  assert.equal(metrics.passed, 2);
  assert.equal(metrics.failed, 1);
  assert.equal(metrics.durationMs.min, 40);
  assert.equal(metrics.durationMs.max, 100);
  assert.equal(metrics.durationMs.avg, 70);
  assert.deepEqual(metrics.exercisedRisks, ['RISK-RES-001', 'RISK-RES-002']);
  assert.deepEqual(metrics.observedFailures, ['FAIL_A', 'FAIL_B']);
});

test('schema válido aceita saída estruturada de Failure Intelligence', () => {
  const parsed = parseAiFailureAdvisory(validFailureAdvisory);
  assert.deepEqual(parsed, validFailureAdvisory);
});

test('schema inválido rejeita campos inexistentes ou valores fora do enum', () => {
  assert.throws(() =>
    parseAiFailureAdvisory({
      ...validFailureAdvisory,
      recoveryAssessment: 'COMPLETELY_RESILIENT',
    }),
  );
});

test('ausência de OPENAI_API_KEY retorna fallback sem chamada externa', async () => {
  const provider = createOpenAiProvider({});
  const context = createSampleContext();
  const outcome = await runFailureAdvisoryAnalysis(provider, context);

  assert.deepEqual(outcome, {
    status: AI_FAILURE_ADVISORY_UNAVAILABLE,
    reason: 'MISSING_API_KEY',
  });

  const formatted = formatFailureAdvisorySummary(outcome, context.resiliencyMetrics);
  assert.match(formatted, /AI Failure Advisory indisponível — Quality Gate não afetado\./);
  assert.match(formatted, /MISSING_API_KEY/);
});

test('provider indisponível retorna fallback consultivo', async () => {
  const provider = new UnavailableAiProvider();
  const context = createSampleContext();
  const outcome = await runFailureAdvisoryAnalysis(provider, context);

  assert.deepEqual(outcome, {
    status: AI_FAILURE_ADVISORY_UNAVAILABLE,
    reason: 'PROVIDER_UNAVAILABLE',
  });
});

test('adapter OpenAI aceita saída estruturada de failure intelligence sem chamada real', async () => {
  let capturedInstructions = '';
  const provider = new OpenAiProvider({
    apiKey: 'fake-test-key',
    responseParser: async (request) => {
      capturedInstructions = request.instructions;
      assert.equal(request.store, false);
      return { output_parsed: validFailureAdvisory };
    },
  });

  const context = createSampleContext();
  const outcome = await runFailureAdvisoryAnalysis(provider, context);

  assert.equal(outcome.status, 'AVAILABLE');
  if (outcome.status === 'AVAILABLE') {
    assert.equal(outcome.advisory.recoveryAssessment, 'RECOVERED_CONSISTENT');
    assert.equal(outcome.advisory.affectedRisks.length, 1);
  }
  assert.match(capturedInstructions, /Failure Intelligence/);
});

test('resposta malformada da OpenAI retorna fallback INVALID_RESPONSE', async () => {
  const provider = new OpenAiProvider({
    apiKey: 'fake-test-key',
    responseParser: async () => ({ output_parsed: 'not-valid-json' }),
  });

  const context = createSampleContext();
  const outcome = await runFailureAdvisoryAnalysis(provider, context);

  assert.deepEqual(outcome, {
    status: AI_FAILURE_ADVISORY_UNAVAILABLE,
    reason: 'INVALID_RESPONSE',
  });
});

test('timeout simulado retorna fallback TIMEOUT_OR_PROVIDER_FAILURE', async () => {
  const provider: AiProvider = {
    name: 'hanging-provider',
    model: 'hanging-model',
    analyze: async () => new Promise<never>(() => undefined),
  };

  const context = createSampleContext();
  const outcome = await runFailureAdvisoryAnalysis(provider, context, 5);

  assert.deepEqual(outcome, {
    status: AI_FAILURE_ADVISORY_UNAVAILABLE,
    reason: 'TIMEOUT_OR_PROVIDER_FAILURE',
  });
});

test('falha simulada do provider retorna fallback TIMEOUT_OR_PROVIDER_FAILURE', async () => {
  const provider: AiProvider = {
    name: 'crashing-provider',
    model: 'crashing-model',
    analyze: async () => {
      throw new Error('network disconnect');
    },
  };

  const context = createSampleContext();
  const outcome = await runFailureAdvisoryAnalysis(provider, context);

  assert.deepEqual(outcome, {
    status: AI_FAILURE_ADVISORY_UNAVAILABLE,
    reason: 'TIMEOUT_OR_PROVIDER_FAILURE',
  });
});

test('buildFailureAdvisoryContext carrega evidências do laboratório real', () => {
  const context = buildFailureAdvisoryContext();
  assert.ok(context.resiliencyEvidences.length >= 6);
  assert.equal(context.resiliencyMetrics.totalScenarios, 6);
  assert.equal(context.resiliencyMetrics.passed, 6);
  assert.equal(context.resiliencyMetrics.failed, 0);
  assert.ok(context.resiliencyMetrics.exercisedRisks.includes('RISK-RES-001'));
});
