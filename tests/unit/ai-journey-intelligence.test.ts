import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  correlateDeterministicJourneys,
  loadJourneyData,
  normalizeJourneyEvidence,
  type NormalizedJourneyEvidence,
} from '../../tools/ai/journey-evidence-loader.js';
import {
  AI_JOURNEY_ADVISORY_UNAVAILABLE,
  buildJourneyAdvisoryContext,
  formatJourneyAdvisorySummary,
  runJourneyAdvisoryAnalysis,
  type JourneyAdvisoryContext,
} from '../../tools/ai/journey-intelligence.js';
import {
  aiJourneyAdvisorySchema,
  parseAiJourneyAdvisory,
  type AiJourneyAdvisory,
} from '../../tools/ai/journey-schema.js';
import { createOpenAiProvider, OpenAiProvider } from '../../tools/ai/openai-provider.js';
import { UnavailableAiProvider, type AiProvider } from '../../tools/ai/provider.js';
import type { NormalizedObservabilityEvidence } from '../../tools/ai/telemetry-evidence-loader.js';
import type { NormalizedResiliencyEvidence } from '../../tools/ai/evidence-loader.js';

const sampleJourneyEvidence: NormalizedJourneyEvidence = {
  journey: 'journey-1-successful-provisioning',
  riskId: 'RISK-JOURNEY-001',
  controlId: 'CTRL-JOURNEY-PROVISIONING-001',
  startedAt: '2026-09-04T06:47:49.431Z',
  acceptedAt: '2026-09-04T06:47:49.474Z',
  completedAt: '2026-09-04T06:47:49.569Z',
  apiLatencyMs: 43,
  endToEndDurationMs: 138,
  recoveryDurationMs: null,
  traceId: 'a50d17714183daecaf379897b3527ebb',
  correlationId: 'corr-journey-5d7d6451-c045-4496-9c7d-0e4dc5043bc7',
  retries: 0,
  redeliveries: 0,
  finalState: {
    instanceId: '3e74b39d-f3c6-40a0-8414-915bf38bfea3',
    operationId: 'f2ca8276-cc26-4564-b9b2-8ce8644ba8b8',
    instanceStatus: 'RUNNING',
    operationStatus: 'SUCCEEDED',
  },
  slaAssessment: {
    apiLatencyMet: true,
    endToEndMet: true,
    recoveryMet: true,
    status: 'MET',
    targetSla: {
      maxApiLatencyMs: 500,
      maxEndToEndDurationMs: 5000,
      maxRecoveryDurationMs: 5000,
    },
  },
  result: 'PASSED',
};

const sampleDegradedJourneyEvidence: NormalizedJourneyEvidence = {
  journey: 'journey-3-transient-nats-failure-recovery',
  riskId: 'RISK-JOURNEY-003',
  controlId: 'CTRL-JOURNEY-BROKER-RECOVERY-001',
  startedAt: '2026-09-04T06:47:50.000Z',
  acceptedAt: '2026-09-04T06:47:50.020Z',
  completedAt: '2026-09-04T06:47:50.250Z',
  apiLatencyMs: 20,
  endToEndDurationMs: 250,
  recoveryDurationMs: 120,
  traceId: 'b71e17714183daecaf379897b3527ecc',
  correlationId: 'corr-nats-recovery-1234',
  retries: 1,
  redeliveries: 0,
  finalState: {
    instanceStatus: 'RUNNING',
    operationStatus: 'SUCCEEDED',
  },
  slaAssessment: {
    apiLatencyMet: true,
    endToEndMet: true,
    recoveryMet: true,
    status: 'MET',
    targetSla: {
      maxApiLatencyMs: 500,
      maxEndToEndDurationMs: 5000,
      maxRecoveryDurationMs: 5000,
    },
  },
  result: 'PASSED',
};

const sampleBreachedJourneyEvidence: NormalizedJourneyEvidence = {
  journey: 'journey-breached-sla',
  riskId: 'RISK-JOURNEY-001',
  controlId: 'CTRL-JOURNEY-PROVISIONING-001',
  startedAt: '2026-09-04T06:47:50.000Z',
  acceptedAt: '2026-09-04T06:47:50.600Z',
  completedAt: '2026-09-04T06:47:56.000Z',
  apiLatencyMs: 600,
  endToEndDurationMs: 6000,
  recoveryDurationMs: null,
  traceId: 'c82f17714183daecaf379897b3527edd',
  correlationId: 'corr-breached-1234',
  retries: 0,
  redeliveries: 0,
  finalState: {
    instanceStatus: 'ERROR',
    operationStatus: 'FAILED',
  },
  slaAssessment: {
    apiLatencyMet: false,
    endToEndMet: false,
    status: 'BREACHED',
    targetSla: {
      maxApiLatencyMs: 500,
      maxEndToEndDurationMs: 5000,
      maxRecoveryDurationMs: 5000,
    },
  },
  result: 'FAILED',
};

const validAdvisoryPayload: AiJourneyAdvisory = {
  executiveSummary: 'As 4 jornadas sintéticas executadas ficaram dentro dos limites [LAB] definidos.',
  degradedJourneys: [],
  slaFindings: [
    {
      subject: 'Conformidade integral de SLA nominal',
      rationale: 'Todas as jornadas sintéticas atingiram status MET com latências abaixo dos limites',
      evidence: ['journey-1-successful-provisioning.json', 'apiLatencyMs <= 43'],
      classification: 'OBSERVED',
    },
  ],
  probableBottlenecks: [
    {
      subject: 'Fronteira Publisher -> NATS sob partição',
      rationale: 'Maior duração relativa observada durante recuperação de publicação assíncrona',
      evidence: ['journey-3-transient-nats-failure-recovery.json'],
      classification: 'INFERRED',
    },
  ],
  affectedRisks: [
    {
      subject: 'RISK-JOURNEY-001',
      rationale: 'Ciclo completo de provisionamento exercitado com validação nos 6 spans',
      evidence: ['CTRL-JOURNEY-PROVISIONING-001'],
      classification: 'OBSERVED',
    },
  ],
  traceCorrelations: [
    {
      subject: 'Rastreabilidade W3C unificada',
      rationale: 'O traceId propagou-se de ponta a ponta sem quebra de contexto',
      evidence: ['traceId: a50d17714183daecaf379897b3527ebb'],
      classification: 'OBSERVED',
    },
  ],
  resilienceCorrelations: [
    {
      subject: 'Recuperação atômica pós-falha',
      rationale: 'Eventos retidos no Outbox foram publicados após restabelecimento',
      evidence: ['recoveryDurationMs: 120'],
      classification: 'OBSERVED',
    },
  ],
  coverageGaps: [
    {
      subject: 'Baseline histórico de regressão temporal',
      rationale: 'Ainda não existe histórico persistido suficiente para afirmar tendência',
      evidence: ['docs/08-synthetic-journeys.md'],
      classification: 'GAP',
    },
  ],
  recommendedInvestigations: [
    {
      subject: 'Monitorar latência de reconexão NATS',
      rationale: 'Avaliar tempo de reconexão sob latências de rede intermediárias',
      evidence: ['journey-3-transient-nats-failure-recovery'],
      classification: 'INFERRED',
    },
  ],
  recommendedTests: [
    {
      subject: 'Jornada com falha concorrente de NATS e Consumer',
      rationale: 'Verificar recuperação combinada de múltiplas fronteiras',
      evidence: ['CTRL-JOURNEY-BROKER-RECOVERY-001'],
      classification: 'GAP',
    },
  ],
  humanQuestions: [
    {
      subject: 'Qual limiar de regressão percentual deve acionar investigação?',
      rationale: 'Necessário para calibrar futura análise de tendências históricas',
      evidence: ['LAB_SYNTHETIC_SLA'],
      classification: 'GAP',
    },
  ],
  confidence: 'HIGH',
};

test('normalização de evidência de jornada sintética valida campos essenciais', () => {
  const normalized = normalizeJourneyEvidence({
    journey: 'journey-1-successful-provisioning',
    riskId: 'RISK-JOURNEY-001',
    controlId: 'CTRL-JOURNEY-PROVISIONING-001',
    startedAt: '2026-09-04T06:47:49.431Z',
    acceptedAt: '2026-09-04T06:47:49.474Z',
    completedAt: '2026-09-04T06:47:49.569Z',
    apiLatencyMs: 43,
    endToEndDurationMs: 138,
    recoveryDurationMs: null,
    traceId: 'a50d17714183daecaf379897b3527ebb',
    correlationId: 'corr-1234',
    retries: 0,
    redeliveries: 0,
    finalState: { status: 'RUNNING' },
    slaAssessment: {
      apiLatencyMet: true,
      endToEndMet: true,
      status: 'MET',
      targetSla: { maxApiLatencyMs: 500, maxEndToEndDurationMs: 5000, maxRecoveryDurationMs: 5000 },
    },
    result: 'PASSED',
  });

  assert.ok(normalized !== null);
  assert.equal(normalized.journey, 'journey-1-successful-provisioning');
  assert.equal(normalized.apiLatencyMs, 43);
  assert.equal(normalized.endToEndDurationMs, 138);
  assert.equal(normalized.slaAssessment.status, 'MET');
  assert.equal(normalized.result, 'PASSED');
});

test('ignora evidência de jornada malformada ou sem campos obrigatórios', () => {
  assert.equal(normalizeJourneyEvidence(null), null);
  assert.equal(normalizeJourneyEvidence({}), null);
  assert.equal(normalizeJourneyEvidence({ journey: 'j1' }), null);
  assert.equal(normalizeJourneyEvidence({ journey: 'j1', riskId: 'R1', controlId: 'C1' }), null);
});

test('carregamento tolera arquivos JSON corrompidos em evidence/journeys', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qe-test-journeys-'));
  try {
    fs.writeFileSync(path.join(tempDir, 'corrupt.json'), '{ invalid json ...');
    fs.writeFileSync(
      path.join(tempDir, 'valid.json'),
      JSON.stringify(sampleJourneyEvidence),
    );

    const loaded = loadJourneyData(tempDir, path.join(tempDir, 'nonexistent-obs'), path.join(tempDir, 'nonexistent-res'));
    assert.equal(loaded.journeyEvidences.length, 1);
    assert.equal(loaded.invalidFileCount, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('diretório inexistente retorna valores padrão seguros', () => {
  const loaded = loadJourneyData('/tmp/path/that/does/not/exist/journeys');
  assert.equal(loaded.journeyEvidences.length, 0);
  assert.equal(loaded.correlation.totalJourneys, 0);
  assert.equal(loaded.correlation.passedJourneys, 0);
  assert.equal(loaded.correlation.failedJourneys, 0);
  assert.equal(loaded.correlation.slaMetCount, 0);
  assert.equal(loaded.correlation.slaBreachedCount, 0);
  assert.equal(loaded.correlation.apiLatency.min, 0);
  assert.equal(loaded.correlation.endToEndDuration.min, 0);
  assert.equal(loaded.correlation.slowestJourney, null);
});

test('agregação determinística calcula SLA MET e SLA BREACHED corretamente', () => {
  const correlation = correlateDeterministicJourneys([
    sampleJourneyEvidence,
    sampleDegradedJourneyEvidence,
    sampleBreachedJourneyEvidence,
  ]);

  assert.equal(correlation.totalJourneys, 3);
  assert.equal(correlation.passedJourneys, 2);
  assert.equal(correlation.failedJourneys, 1);
  assert.equal(correlation.slaMetCount, 2);
  assert.equal(correlation.slaBreachedCount, 1);
});

test('agregação calcula estatísticas de latência mín, máx e média de ponta a ponta', () => {
  const correlation = correlateDeterministicJourneys([
    sampleJourneyEvidence, // api: 43, e2e: 138
    sampleDegradedJourneyEvidence, // api: 20, e2e: 250, recovery: 120
  ]);

  assert.equal(correlation.apiLatency.min, 20);
  assert.equal(correlation.apiLatency.max, 43);
  assert.equal(correlation.apiLatency.avg, 31.5);

  assert.equal(correlation.endToEndDuration.min, 138);
  assert.equal(correlation.endToEndDuration.max, 250);
  assert.equal(correlation.endToEndDuration.avg, 194);

  assert.equal(correlation.recoveryDuration.min, 120);
  assert.equal(correlation.recoveryDuration.max, 120);
  assert.equal(correlation.recoveryDuration.avg, 120);
});

test('identifica determinísticamente a jornada mais lenta', () => {
  const correlation = correlateDeterministicJourneys([
    sampleJourneyEvidence, // e2e: 138
    sampleDegradedJourneyEvidence, // e2e: 250
  ]);

  assert.ok(correlation.slowestJourney !== null);
  assert.equal(correlation.slowestJourney?.journey, 'journey-3-transient-nats-failure-recovery');
  assert.equal(correlation.slowestJourney?.endToEndDurationMs, 250);
});

test('agrega retries totais e redeliveries totais', () => {
  const correlation = correlateDeterministicJourneys([
    sampleJourneyEvidence, // retries: 0, redeliveries: 0
    sampleDegradedJourneyEvidence, // retries: 1, redeliveries: 0
    { ...sampleJourneyEvidence, retries: 2, redeliveries: 1 },
  ]);

  assert.equal(correlation.totalRetries, 3);
  assert.equal(correlation.totalRedeliveries, 1);
});

test('correlaciona jornadas com traces e falhas observadas', () => {
  const sampleObservability: NormalizedObservabilityEvidence[] = [
    {
      scenario: 'scenario-4-nats-publish-failure',
      riskId: 'RISK-OBS-004',
      controlId: 'CTRL-OBS-004',
      traceId: sampleDegradedJourneyEvidence.traceId,
      correlationId: sampleDegradedJourneyEvidence.correlationId,
      spansObserved: [
        {
          name: 'nats.publish',
          spanId: 'span-err-1',
          status: 'ERROR',
          attributes: {},
        },
      ],
      metricsObserved: {},
      finalState: {},
      result: 'PASSED',
    },
  ];

  const sampleResiliency: NormalizedResiliencyEvidence[] = [
    {
      scenario: 'nats-outage-during-publish',
      riskId: 'RISK-RES-001',
      controlId: 'CTRL-RES-001',
      startedAt: '2026-09-04T06:00:00Z',
      recoveredAt: '2026-09-04T06:00:01Z',
      durationMs: 100,
      observedFailure: 'SIMULATED_PUBLISH_FAILURE',
      finalState: {},
      result: 'PASSED',
    },
  ];

  const correlation = correlateDeterministicJourneys(
    [sampleJourneyEvidence, sampleDegradedJourneyEvidence],
    sampleObservability,
    sampleResiliency,
  );

  assert.ok(correlation.observedFailures.includes('SIMULATED_PUBLISH_FAILURE'));
  const degradedCorr = correlation.journeyCorrelations.find(
    (j) => j.journey === 'journey-3-transient-nats-failure-recovery',
  );
  assert.ok(degradedCorr);
  assert.ok(degradedCorr.relatedErrorSpans.some((s) => s.includes('nats.publish')));
  assert.ok(degradedCorr.relatedFailures.some((f) => f.includes('NATS')));
});

test('detecta tendências e variações quando existem múltiplas execuções da mesma jornada', () => {
  const run1: NormalizedJourneyEvidence = {
    ...sampleJourneyEvidence,
    startedAt: '2026-09-04T06:00:00Z',
    apiLatencyMs: 20,
    endToEndDurationMs: 100,
    retries: 0,
  };
  const run2: NormalizedJourneyEvidence = {
    ...sampleJourneyEvidence,
    startedAt: '2026-09-04T06:10:00Z',
    apiLatencyMs: 50, // aumento > 1.5x
    endToEndDurationMs: 300, // aumento > 1.5x
    retries: 2, // aumento
  };

  const correlation = correlateDeterministicJourneys([run1, run2]);
  assert.ok(correlation.trendFindings.length >= 2);
  assert.ok(correlation.trendFindings.some((t) => t.metric === 'endToEndDuration'));
  assert.ok(correlation.trendFindings.some((t) => t.metric === 'apiLatency'));
  assert.ok(correlation.trendFindings.some((t) => t.metric === 'retries'));
});

test('schema Zod aceita saída estruturada válida com classificações OBSERVED, INFERRED, GAP', () => {
  const parsed = parseAiJourneyAdvisory(validAdvisoryPayload);
  assert.equal(parsed.confidence, 'HIGH');
  assert.ok(parsed.executiveSummary.includes('limites [LAB] definidos'));
  assert.equal(parsed.slaFindings[0]!.classification, 'OBSERVED');
  assert.equal(parsed.probableBottlenecks[0]!.classification, 'INFERRED');
  assert.equal(parsed.coverageGaps[0]!.classification, 'GAP');
});

test('schema Zod rejeita finding sem classification ou com valor fora do enum', () => {
  const invalid = {
    ...validAdvisoryPayload,
    slaFindings: [
      {
        subject: 'Inválido',
        rationale: 'Sem classificação',
        evidence: ['teste'],
        classification: 'UNKNOWN_VALUE',
      },
    ],
  };
  assert.throws(() => parseAiJourneyAdvisory(invalid));
});

test('schema Zod rejeita finding com lista de evidence vazia', () => {
  const invalid = {
    ...validAdvisoryPayload,
    slaFindings: [
      {
        subject: 'Inválido',
        rationale: 'Sem evidência citada',
        evidence: [],
        classification: 'OBSERVED',
      },
    ],
  };
  assert.throws(() => parseAiJourneyAdvisory(invalid));
});

test('ausência de OPENAI_API_KEY retorna fallback AI_JOURNEY_ADVISORY_UNAVAILABLE', async () => {
  const originalEnv = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  try {
    const provider = createOpenAiProvider();
    assert.ok(provider instanceof UnavailableAiProvider);

    const context = buildJourneyAdvisoryContext();
    const outcome = await runJourneyAdvisoryAnalysis(provider, context);

    assert.equal(outcome.status, AI_JOURNEY_ADVISORY_UNAVAILABLE);
    if (outcome.status === AI_JOURNEY_ADVISORY_UNAVAILABLE) {
      assert.equal(outcome.reason, 'MISSING_API_KEY');
    }
  } finally {
    if (originalEnv) process.env.OPENAI_API_KEY = originalEnv;
  }
});

test('provider indisponível retorna fallback consultivo PROVIDER_UNAVAILABLE', async () => {
  const unavailableProvider = new UnavailableAiProvider('PROVIDER_UNAVAILABLE');
  const context = buildJourneyAdvisoryContext();
  const outcome = await runJourneyAdvisoryAnalysis(unavailableProvider, context);

  assert.equal(outcome.status, AI_JOURNEY_ADVISORY_UNAVAILABLE);
  if (outcome.status === AI_JOURNEY_ADVISORY_UNAVAILABLE) {
    assert.equal(outcome.reason, 'PROVIDER_UNAVAILABLE');
  }
});

test('adapter mock processa structured output de jornadas sem chamada de rede real', async () => {
  const mockProvider: AiProvider = {
    name: 'mock-provider',
    model: 'mock-model',
    analyze: async () => validAdvisoryPayload,
  };

  const context = buildJourneyAdvisoryContext();
  const outcome = await runJourneyAdvisoryAnalysis(mockProvider, context);

  assert.equal(outcome.status, 'AVAILABLE');
  if (outcome.status === 'AVAILABLE') {
    assert.equal(outcome.provider, 'mock-provider');
    assert.equal(outcome.advisory.confidence, 'HIGH');
    assert.equal(outcome.advisory.slaFindings.length, 1);
  }
});

test('resposta malformada do provider retorna fallback INVALID_RESPONSE', async () => {
  const brokenProvider: AiProvider = {
    name: 'broken-provider',
    model: 'mock-model',
    analyze: async () => ({ invalidJson: true }),
  };

  const context = buildJourneyAdvisoryContext();
  const outcome = await runJourneyAdvisoryAnalysis(brokenProvider, context);

  assert.equal(outcome.status, AI_JOURNEY_ADVISORY_UNAVAILABLE);
  if (outcome.status === AI_JOURNEY_ADVISORY_UNAVAILABLE) {
    assert.equal(outcome.reason, 'INVALID_RESPONSE');
  }
});

test('timeout simulado retorna fallback TIMEOUT_OR_PROVIDER_FAILURE', async () => {
  const slowProvider: AiProvider = {
    name: 'slow-provider',
    model: 'mock-model',
    analyze: async () => new Promise((resolve) => setTimeout(resolve, 500)),
  };

  const context = buildJourneyAdvisoryContext();
  const outcome = await runJourneyAdvisoryAnalysis(slowProvider, context, 20);

  assert.equal(outcome.status, AI_JOURNEY_ADVISORY_UNAVAILABLE);
  if (outcome.status === AI_JOURNEY_ADVISORY_UNAVAILABLE) {
    assert.equal(outcome.reason, 'TIMEOUT_OR_PROVIDER_FAILURE');
  }
});

test('formatação do resumo de jornadas inclui seções com badges de classificação', () => {
  const outcome = {
    status: 'AVAILABLE' as const,
    provider: 'openai',
    model: 'gpt-5.4-mini',
    advisory: validAdvisoryPayload,
  };

  const correlation = correlateDeterministicJourneys([sampleJourneyEvidence, sampleDegradedJourneyEvidence]);
  const summary = formatJourneyAdvisorySummary(outcome, correlation);

  assert.ok(summary.includes('## QE Intelligence Layer — Journey Intelligence (AI-04)'));
  assert.ok(summary.includes('`[OBSERVED]`'));
  assert.ok(summary.includes('`[INFERRED]`'));
  assert.ok(summary.includes('`[GAP]`'));
  assert.ok(summary.includes('Conformidade de SLA sintético: **2 MET** / **0 BREACHED**'));
  assert.ok(summary.includes('Latência da API'));
  assert.ok(summary.includes('Duração E2E completa'));
});

test('buildJourneyAdvisoryContext carrega evidências reais do laboratório', () => {
  const context = buildJourneyAdvisoryContext();
  assert.equal(context.purpose, 'journey-intelligence-advisory');
  assert.ok(context.journeyEvidences.length >= 4);
  assert.ok(context.journeyCorrelation.totalJourneys >= 4);
  assert.equal(context.journeyCorrelation.passedJourneys, 4);
  assert.equal(context.journeyCorrelation.slaMetCount, 4);
  assert.ok(context.journeyCorrelation.apiLatency.max <= 500);
  assert.ok(context.journeyCorrelation.endToEndDuration.max <= 5000);
});
