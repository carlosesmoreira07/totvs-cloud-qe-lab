import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  computeTelemetryCorrelation,
  loadTelemetryData,
  normalizeObservabilityEvidence,
  type NormalizedObservabilityEvidence,
} from '../../tools/ai/telemetry-evidence-loader.js';
import {
  AI_TELEMETRY_ADVISORY_UNAVAILABLE,
  buildTelemetryAdvisoryContext,
  formatTelemetryAdvisorySummary,
  runTelemetryAdvisoryAnalysis,
  type TelemetryAdvisoryContext,
} from '../../tools/ai/telemetry-intelligence.js';
import {
  aiTelemetryAdvisorySchema,
  parseAiTelemetryAdvisory,
  type AiTelemetryAdvisory,
} from '../../tools/ai/telemetry-schema.js';
import { createOpenAiProvider, OpenAiProvider } from '../../tools/ai/openai-provider.js';
import { UnavailableAiProvider, type AiProvider } from '../../tools/ai/provider.js';
import type { NormalizedResiliencyEvidence } from '../../tools/ai/evidence-loader.js';

const sampleObservabilityEvidence: NormalizedObservabilityEvidence = {
  scenario: 'scenario-1-provisioning-trace',
  riskId: 'RISK-OBS-001',
  controlId: 'CTRL-OBS-TRACE-TREE-001',
  traceId: '1b258768bad4fbec6d91b798e63a8862',
  correlationId: 'corr-9d780f75-53f6-446e-89e3-37bd3070ed1d',
  spansObserved: [
    {
      name: 'http.request',
      spanId: 'f8c05a3857fa2b33',
      status: 'OK',
      attributes: { 'http.route': '/v1/instances', 'http.status_code': 202 },
    },
    {
      name: 'db.transaction.create_instance',
      spanId: 'f5b01afc70ca8ec6',
      parentSpanId: 'f8c05a3857fa2b33',
      status: 'OK',
      attributes: { 'db.system': 'postgresql' },
    },
    {
      name: 'outbox.create_event',
      spanId: 'fc2c54f2166d9f35',
      parentSpanId: 'f5b01afc70ca8ec6',
      status: 'OK',
      attributes: { 'event.type': 'instance.provisioning.requested' },
    },
    {
      name: 'nats.publish',
      spanId: 'a593f49fc59b1aec',
      parentSpanId: 'fc2c54f2166d9f35',
      status: 'OK',
      attributes: { 'messaging.system': 'nats' },
    },
    {
      name: 'nats.consume',
      spanId: '57bc8e6f5ee79599',
      parentSpanId: 'a593f49fc59b1aec',
      status: 'OK',
      attributes: { 'messaging.operation': 'process' },
    },
    {
      name: 'db.transaction.update_state',
      spanId: '77f466fd726fa6b6',
      parentSpanId: '57bc8e6f5ee79599',
      status: 'OK',
      attributes: { 'db.operation': 'update_state' },
    },
  ],
  metricsObserved: {
    http_requests_total: 1,
    outbox_pending_count: 0,
    messages_processed_total: 1,
  },
  finalState: {
    instanceId: '3e564e19-406f-4588-9d73-84da48fab519',
    status: 'RUNNING',
  },
  result: 'PASSED',
};

const sampleResiliencyEvidence: NormalizedResiliencyEvidence = {
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

const validTelemetryAdvisory: AiTelemetryAdvisory = {
  executiveSummary: 'A cadeia de telemetria cobriu as 6 etapas distribuídas com correlação W3C mantida e erros visíveis.',
  probableDegradationPoints: [
    {
      subject: 'Fronteira Publisher -> NATS JetStream',
      rationale: 'O span nats.publish registrou status ERROR durante corte simulado',
      evidence: ['nats.publish spanId: d5289be0b39c6e94'],
      classification: 'OBSERVED',
    },
    {
      subject: 'Retenção temporária no PostgreSQL Outbox',
      rationale: 'A degradação provavelmente causou represamento de mensagens pendentes antes da republicação',
      evidence: ['outbox_pending_count: 1'],
      classification: 'INFERRED',
    },
  ],
  affectedRisks: [
    {
      subject: 'RISK-OBS-004',
      rationale: 'Falha de mensageria NATS foi devidamente capturada no trace e métricas',
      evidence: ['CTRL-OBS-NATS-ERROR-VISIBILITY-001'],
      classification: 'OBSERVED',
    },
  ],
  traceFindings: [
    {
      subject: 'Árvore de spans completa no fluxo feliz',
      rationale: 'Todos os 6 spans foram conectados respeitando parent-child causal',
      evidence: ['scenario-1-provisioning-trace.json'],
      classification: 'OBSERVED',
    },
  ],
  metricFindings: [
    {
      subject: 'Incremento acurado de falhas de publicação',
      rationale: 'outbox_publish_failures_total incrementou em exata sincronia com o erro do span',
      evidence: ['outbox_publish_failures_total: 1'],
      classification: 'OBSERVED',
    },
  ],
  instrumentationGaps: [
    {
      subject: 'Ausência de span de latência intermediária',
      rationale: 'Não há medição de latência de handshake antes da queda abrupta do NATS',
      evidence: ['docs/07-observability-telemetry.md'],
      classification: 'GAP',
    },
  ],
  consistencyConcerns: [],
  recommendedInvestigations: [
    {
      subject: 'Inspecionar métricas de pool de conexões do PostgreSQL sob saturação',
      rationale: 'Verificar se o outbox publisher sofre contenção de conexões',
      evidence: ['postgres-store.ts'],
      classification: 'INFERRED',
    },
  ],
  recommendedTests: [
    {
      subject: 'Cenário com jitter e perda parcial de pacotes',
      rationale: 'Validar comportamento do trace parent sob latência progressiva',
      evidence: ['CTRL-RES-NATS-OUTAGE-001'],
      classification: 'GAP',
    },
  ],
  humanQuestions: [
    {
      subject: 'Qual o limiar aceitável para outbox_pending_count antes de acionar alerta crítico?',
      rationale: 'Necessário para definir regras de observabilidade em ambientes compartilhados',
      evidence: ['telemetry.ts'],
      classification: 'GAP',
    },
  ],
  confidence: 'HIGH',
};

function createSampleContext(): TelemetryAdvisoryContext {
  return {
    purpose: 'telemetry-intelligence-advisory',
    promptVersion: 'qe-telemetry-advisory-v1',
    guardrails: ['no-release-decision', 'differentiate-observed-inferred-gap'],
    changes: {
      generatedBy: 'deterministic-impact-context',
      decisionAuthority: 'human',
      changedFiles: ['apps/control-plane-mock/src/telemetry.ts'],
      candidateRisks: ['perda de rastreabilidade'],
      candidateControls: ['npm run test:observability'],
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
      total: 7,
      passed: 7,
      failed: 0,
      flaky: 0,
      skipped: 0,
      durationMs: 4500,
      controls: [{ name: 'Cenário 1: Árvore completa', status: 'passed' }],
    },
    telemetryCorrelation: computeTelemetryCorrelation(
      [sampleObservabilityEvidence],
      [sampleResiliencyEvidence],
    ),
    observabilityEvidences: [sampleObservabilityEvidence],
    resiliencyEvidences: [sampleResiliencyEvidence],
  };
}

test('normalização de evidência de observabilidade valida campos estruturais', () => {
  const normalized = normalizeObservabilityEvidence(sampleObservabilityEvidence);
  assert.ok(normalized);
  assert.equal(normalized.scenario, 'scenario-1-provisioning-trace');
  assert.equal(normalized.riskId, 'RISK-OBS-001');
  assert.equal(normalized.controlId, 'CTRL-OBS-TRACE-TREE-001');
  assert.equal(normalized.traceId, '1b258768bad4fbec6d91b798e63a8862');
  assert.equal(normalized.spansObserved.length, 6);
  assert.equal(normalized.metricsObserved.http_requests_total, 1);
});

test('ignora evidência de observabilidade malformada ou sem identificadores essenciais', () => {
  assert.equal(normalizeObservabilityEvidence(null), null);
  assert.equal(normalizeObservabilityEvidence({}), null);
  assert.equal(normalizeObservabilityEvidence({ scenario: 's1' }), null);
  assert.equal(normalizeObservabilityEvidence({ scenario: 's1', riskId: 'R1' }), null);
  assert.equal(normalizeObservabilityEvidence({ scenario: 's1', riskId: 'R1', controlId: 'C1' }), null);
});

test('carregamento tolera arquivos JSON corrompidos em evidence/observability', () => {
  const tempObsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qe-test-obs-'));
  const tempResDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qe-test-res-'));
  try {
    fs.writeFileSync(path.join(tempObsDir, 'broken.json'), '{ broken json syntax');
    fs.writeFileSync(path.join(tempObsDir, 'valid.json'), JSON.stringify(sampleObservabilityEvidence));
    fs.writeFileSync(path.join(tempResDir, 'valid.json'), JSON.stringify(sampleResiliencyEvidence));

    const loaded = loadTelemetryData(tempObsDir, tempResDir);
    assert.equal(loaded.observabilityEvidences.length, 1);
    assert.equal(loaded.resiliencyEvidences.length, 1);
    assert.equal(loaded.invalidFileCount, 1);
    assert.equal(loaded.correlation.totalTraces, 1);
  } finally {
    fs.rmSync(tempObsDir, { recursive: true, force: true });
    fs.rmSync(tempResDir, { recursive: true, force: true });
  }
});

test('diretório inexistente retorna correlação com valores padrão seguros', () => {
  const loaded = loadTelemetryData('c:/non-existent-dir-obs-12345', 'c:/non-existent-dir-res-12345');
  assert.equal(loaded.observabilityEvidences.length, 0);
  assert.equal(loaded.resiliencyEvidences.length, 0);
  assert.equal(loaded.correlation.totalTraces, 0);
  assert.equal(loaded.correlation.observedSpans.length, 0);
  assert.equal(loaded.correlation.missingSpans.length, 0);
  assert.equal(loaded.correlation.errorTraces.length, 0);
});

test('correlação detecta traces com span ausente em relação à cadeia esperada', () => {
  const incompleteEvidence: NormalizedObservabilityEvidence = {
    ...sampleObservabilityEvidence,
    scenario: 'scenario-incomplete-trace',
    traceId: 'trace-incomplete-123',
    spansObserved: [
      { name: 'http.request', spanId: 's1', status: 'OK', attributes: {} },
      { name: 'db.transaction.create_instance', spanId: 's2', status: 'OK', attributes: {} },
      { name: 'outbox.create_event', spanId: 's3', status: 'OK', attributes: {} },
      // Falta nats.publish, nats.consume e db.transaction.update_state
    ],
  };

  const correlation = computeTelemetryCorrelation([incompleteEvidence], []);
  assert.equal(correlation.missingSpans.length, 1);
  assert.equal(correlation.missingSpans[0]?.scenario, 'scenario-incomplete-trace');
  assert.deepEqual(correlation.missingSpans[0]?.missingSpans, [
    'nats.publish',
    'nats.consume',
    'db.transaction.update_state',
  ]);
});

test('correlação identifica spans com status ERROR e agrega métricas determinísticas', () => {
  const errorEvidence: NormalizedObservabilityEvidence = {
    ...sampleObservabilityEvidence,
    scenario: 'scenario-4-nats-publish-failure',
    traceId: 'trace-error-999',
    spansObserved: [
      { name: 'http.request', spanId: 's1', status: 'OK', attributes: {} },
      { name: 'nats.publish', spanId: 's2', status: 'ERROR', attributes: {} },
    ],
    metricsObserved: {
      http_requests_total: 5,
      outbox_pending_count: 2,
      outbox_publish_failures_total: 3,
    },
    observedIssue: 'SIMULATED_PUBLISH_FAILURE',
  };

  const correlation = computeTelemetryCorrelation([errorEvidence], [sampleResiliencyEvidence]);
  assert.equal(correlation.errorTraces.length, 1);
  assert.equal(correlation.errorTraces[0]?.spanName, 'nats.publish');
  assert.equal(correlation.errorTraces[0]?.status, 'ERROR');
  assert.equal(correlation.metricsSummary.httpRequestsTotal, 5);
  assert.equal(correlation.metricsSummary.outboxPendingCount, 2);
  assert.equal(correlation.metricsSummary.outboxPublishFailuresTotal, 3);
  assert.ok(correlation.exercisedRisks.includes('RISK-OBS-001'));
  assert.ok(correlation.exercisedRisks.includes('RISK-RES-001'));
  assert.equal(correlation.recoveryDuration.avg, 57);
});

test('schema Zod aceita saída estruturada com classificações válidas OBSERVED, INFERRED, GAP', () => {
  const parsed = parseAiTelemetryAdvisory(validTelemetryAdvisory);
  assert.deepEqual(parsed, validTelemetryAdvisory);
  assert.equal(parsed.probableDegradationPoints[0]?.classification, 'OBSERVED');
  assert.equal(parsed.probableDegradationPoints[1]?.classification, 'INFERRED');
  assert.equal(parsed.instrumentationGaps[0]?.classification, 'GAP');
});

test('schema Zod rejeita finding sem classification ou com valor fora do enum', () => {
  assert.throws(() =>
    parseAiTelemetryAdvisory({
      ...validTelemetryAdvisory,
      probableDegradationPoints: [
        {
          subject: 'Teste inválido',
          rationale: 'Sem classificação válida',
          evidence: ['ev-1'],
          classification: 'SPECULATION', // Invalido!
        },
      ],
    }),
  );
});

test('schema Zod rejeita finding com lista de evidence vazia', () => {
  assert.throws(() =>
    parseAiTelemetryAdvisory({
      ...validTelemetryAdvisory,
      probableDegradationPoints: [
        {
          subject: 'Teste inválido',
          rationale: 'Sem evidência citada',
          evidence: [], // Invalido! Mínimo 1
          classification: 'OBSERVED',
        },
      ],
    }),
  );
});

test('ausência de OPENAI_API_KEY retorna fallback AI_TELEMETRY_ADVISORY_UNAVAILABLE', async () => {
  const provider = createOpenAiProvider({});
  const context = createSampleContext();
  const outcome = await runTelemetryAdvisoryAnalysis(provider, context);

  assert.deepEqual(outcome, {
    status: AI_TELEMETRY_ADVISORY_UNAVAILABLE,
    reason: 'MISSING_API_KEY',
  });

  const formatted = formatTelemetryAdvisorySummary(outcome, context.telemetryCorrelation);
  assert.match(formatted, /AI Telemetry Advisory indisponível — Quality Gate não afetado\./);
  assert.match(formatted, /MISSING_API_KEY/);
});

test('provider indisponível retorna fallback consultivo PROVIDER_UNAVAILABLE', async () => {
  const provider = new UnavailableAiProvider();
  const context = createSampleContext();
  const outcome = await runTelemetryAdvisoryAnalysis(provider, context);

  assert.deepEqual(outcome, {
    status: AI_TELEMETRY_ADVISORY_UNAVAILABLE,
    reason: 'PROVIDER_UNAVAILABLE',
  });
});

test('adapter OpenAI processa structured output de telemetria sem chamada real', async () => {
  let capturedInstructions = '';
  const provider = new OpenAiProvider({
    apiKey: 'fake-test-key',
    responseParser: async (request) => {
      capturedInstructions = request.instructions;
      assert.equal(request.store, false);
      return { output_parsed: validTelemetryAdvisory };
    },
  });

  const context = createSampleContext();
  const outcome = await runTelemetryAdvisoryAnalysis(provider, context);

  assert.equal(outcome.status, 'AVAILABLE');
  if (outcome.status === 'AVAILABLE') {
    assert.equal(outcome.advisory.confidence, 'HIGH');
    assert.equal(outcome.advisory.probableDegradationPoints.length, 2);
    assert.equal(outcome.advisory.instrumentationGaps.length, 1);
  }
  assert.match(capturedInstructions, /Telemetry & Trace Intelligence/);
  assert.match(capturedInstructions, /REGRA RÍGIDA ANTI-ALUCINAÇÃO/);
});

test('resposta malformada da OpenAI retorna fallback INVALID_RESPONSE', async () => {
  const provider = new OpenAiProvider({
    apiKey: 'fake-test-key',
    responseParser: async () => ({ output_parsed: 'invalid-string-not-object' }),
  });

  const context = createSampleContext();
  const outcome = await runTelemetryAdvisoryAnalysis(provider, context);

  assert.deepEqual(outcome, {
    status: AI_TELEMETRY_ADVISORY_UNAVAILABLE,
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
  const outcome = await runTelemetryAdvisoryAnalysis(provider, context, 5);

  assert.deepEqual(outcome, {
    status: AI_TELEMETRY_ADVISORY_UNAVAILABLE,
    reason: 'TIMEOUT_OR_PROVIDER_FAILURE',
  });
});

test('formatação do resumo de telemetria inclui seções com badges de classificação', () => {
  const outcome = {
    status: 'AVAILABLE' as const,
    provider: 'openai',
    model: 'gpt-5.4-mini',
    advisory: validTelemetryAdvisory,
  };
  const context = createSampleContext();
  const formatted = formatTelemetryAdvisorySummary(outcome, context.telemetryCorrelation);

  assert.match(formatted, /## QE Intelligence Layer — Telemetry & Trace Intelligence \(AI-03\)/);
  assert.match(formatted, /`\[OBSERVED\]`/);
  assert.match(formatted, /`\[INFERRED\]`/);
  assert.match(formatted, /`\[GAP\]`/);
  assert.match(formatted, /Traces analisados:/);
  assert.match(formatted, /Fronteira Publisher -> NATS JetStream/);
});

test('buildTelemetryAdvisoryContext carrega evidências reais do laboratório', () => {
  const context = buildTelemetryAdvisoryContext();
  assert.ok(context.observabilityEvidences.length >= 7);
  assert.ok(context.resiliencyEvidences.length >= 6);
  assert.ok(context.telemetryCorrelation.totalTraces >= 7);
  assert.ok(context.telemetryCorrelation.exercisedRisks.includes('RISK-OBS-001'));
  assert.ok(context.telemetryCorrelation.exercisedRisks.includes('RISK-RES-001'));
  assert.ok(context.telemetryCorrelation.observedSpans.includes('http.request'));
  assert.ok(context.telemetryCorrelation.observedSpans.includes('nats.publish'));
});
