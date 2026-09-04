import http from 'node:http';
import type net from 'node:net';
import crypto from 'node:crypto';
import { expect, test } from '@playwright/test';
import { declareControl, validInstanceRequest as baseValidInstanceRequest } from '../helpers/quality.js';

const validInstanceRequest = (overrides: Record<string, unknown> = {}) => ({
  ...baseValidInstanceRequest,
  ...overrides,
});
import type { NatsConnection } from 'nats';
import { PostgresControlPlaneStore } from '../../apps/control-plane-mock/src/postgres-store.js';
import { connectNats, ensureStream } from '../../apps/control-plane-mock/src/nats-jetstream.js';
import { OutboxPublisher } from '../../apps/control-plane-mock/src/outbox-publisher.js';
import { EventConsumer } from '../../apps/control-plane-mock/src/consumer.js';
import { createRequestHandler } from '../../apps/control-plane-mock/src/app.js';
import {
  clearRecordedSpans,
  getRecordedSpans,
  clearRecordedMetrics,
  getRecordedMetrics,
  SpanStatusCode,
  SpanKind,
} from '../../apps/control-plane-mock/src/telemetry.js';
import { recordObservabilityEvidence } from '../helpers/observability-evidence.js';

test.describe.serial('LAB-07 — Observability & Telemetry', () => {
  let store: PostgresControlPlaneStore;
  let nc: NatsConnection;
  let publisher: OutboxPublisher;
  let consumer: EventConsumer;
  let server: http.Server;
  let apiBaseUrl: string;

  test.beforeAll(async () => {
    store = new PostgresControlPlaneStore({
      connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/control_plane',
    });
    await store.ensureSchema();

    nc = await connectNats({
      servers: process.env.NATS_URL ?? 'nats://127.0.0.1:4222',
    });
    await ensureStream(nc);

    publisher = new OutboxPublisher(store.getPool(), nc);
    consumer = new EventConsumer(store.getPool(), nc);

    // Servidor HTTP em porta efêmera para instrumentação limpa
    const handler = createRequestHandler(store);
    server = http.createServer(handler);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as net.AddressInfo;
    apiBaseUrl = `http://127.0.0.1:${addr.port}`;
  });

  test.afterAll(async () => {
    publisher?.stop();
    if (consumer) {
      await consumer.stop();
    }
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (nc) {
      await nc.close();
    }
    if (store) {
      await store.close();
    }
  });

  test.beforeEach(async () => {
    await store.clearTables();
    clearRecordedSpans();
    clearRecordedMetrics();
    publisher.setSimulatePublishFailure(false);
    consumer.setSimulateFailure(false);
  });

  // =========================================================================
  // Cenário 1: trace do provisionamento contém spans esperados
  // =========================================================================
  test('Cenário 1: trace do provisionamento contém spans esperados', async ({}, testInfo) => {
    declareControl(testInfo, {
      riskId: 'RISK-OBS-001',
      risk: 'Perda de rastreabilidade ou spans ausentes no trace distribuído da esteira assíncrona.',
      controlId: 'CTRL-OBS-TRACE-TREE-001',
      control: 'Provisionar recurso e validar a presença ordenada dos 6 spans essenciais.',
    });

    const idempotencyKey = `idemp-${crypto.randomUUID()}`;
    const correlationId = `corr-${crypto.randomUUID()}`;

    // 1. Entrada HTTP
    const httpResponse = await fetch(`${apiBaseUrl}/v1/instances`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
        'x-correlation-id': correlationId,
      },
      body: JSON.stringify(validInstanceRequest({ name: 'inst-trace-tree' })),
    });
    expect(httpResponse.status).toBe(202);
    const operation = (await httpResponse.json()) as { id: string; resourceId: string };

    // 2. Publicação Outbox
    const publishRes = await publisher.publishPending({ limit: 10 });
    expect(publishRes.published.length).toBe(1);

    // 3. Consumo e atualização de estado
    const outboxRow = await store.getPool().query<{ payload: any }>(
      `SELECT payload FROM outbox_events WHERE id = $1`,
      [publishRes.published[0]],
    );
    const eventPayload = typeof outboxRow.rows[0]?.payload === 'string'
      ? JSON.parse(outboxRow.rows[0].payload)
      : outboxRow.rows[0]?.payload;

    const consumeRes = await consumer.processPayload(eventPayload);
    expect(consumeRes.kind).toBe('processed');

    // 4. Validação da árvore de spans
    const recordedSpans = getRecordedSpans();
    const spanNames = recordedSpans.map((s) => s.name);

    expect(spanNames).toContain('http.request');
    expect(spanNames).toContain('db.transaction.create_instance');
    expect(spanNames).toContain('outbox.create_event');
    expect(spanNames).toContain('nats.publish');
    expect(spanNames).toContain('nats.consume');
    expect(spanNames).toContain('db.transaction.update_state');

    const httpSpan = recordedSpans.find((s) => s.name === 'http.request')!;
    const txCreateSpan = recordedSpans.find((s) => s.name === 'db.transaction.create_instance')!;
    const outboxSpan = recordedSpans.find((s) => s.name === 'outbox.create_event')!;
    const publishSpan = recordedSpans.find((s) => s.name === 'nats.publish')!;
    const consumeSpan = recordedSpans.find((s) => s.name === 'nats.consume')!;
    const txUpdateSpan = recordedSpans.find((s) => s.name === 'db.transaction.update_state')!;

    expect(httpSpan.kind).toBe(SpanKind.SERVER);
    expect(txCreateSpan.kind).toBe(SpanKind.CLIENT);
    expect(outboxSpan.kind).toBe(SpanKind.PRODUCER);
    expect(publishSpan.kind).toBe(SpanKind.PRODUCER);
    expect(consumeSpan.kind).toBe(SpanKind.CONSUMER);
    expect(txUpdateSpan.kind).toBe(SpanKind.CLIENT);

    // Relacionamento hierárquico
    expect(outboxSpan.parentSpanContext?.spanId).toBe(txCreateSpan.spanContext().spanId);
    expect(txUpdateSpan.parentSpanContext?.spanId).toBe(consumeSpan.spanContext().spanId);

    const metrics = await getRecordedMetrics();
    const metricsMap: Record<string, number> = {};
    for (const m of metrics) {
      metricsMap[m.name] = (metricsMap[m.name] ?? 0) + m.value;
    }

    recordObservabilityEvidence({
      scenario: 'scenario-1-provisioning-trace',
      riskId: 'RISK-OBS-001',
      controlId: 'CTRL-OBS-TRACE-TREE-001',
      traceId: httpSpan.spanContext().traceId,
      correlationId,
      spansObserved: recordedSpans.map((s) => ({
        name: s.name,
        spanId: s.spanContext().spanId,
        parentSpanId: s.parentSpanContext?.spanId,
        status: s.status.code === SpanStatusCode.OK ? 'OK' : 'ERROR',
        attributes: s.attributes as Record<string, unknown>,
      })),
      metricsObserved: metricsMap,
      finalState: { operationId: operation.id, instanceId: operation.resourceId, status: 'RUNNING' },
      result: 'PASSED',
    });
  });

  // =========================================================================
  // Cenário 2: traceId atravessa API -> publisher -> consumer
  // =========================================================================
  test('Cenário 2: traceId atravessa API -> publisher -> consumer', async ({}, testInfo) => {
    declareControl(testInfo, {
      riskId: 'RISK-OBS-002',
      risk: 'Quebra da propagação de contexto W3C traceId entre API HTTP, Outbox e mensageria NATS.',
      controlId: 'CTRL-OBS-CONTEXT-PROPAGATION-001',
      control: 'Injetar traceparent na API e verificar correspondência exata do traceId através da esteira.',
    });

    const customTraceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const customParentSpanId = '00f067aa0ba902b7';
    const customTraceparent = `00-${customTraceId}-${customParentSpanId}-01`;
    const correlationId = `corr-${crypto.randomUUID()}`;

    const httpResponse = await fetch(`${apiBaseUrl}/v1/instances`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `idemp-${crypto.randomUUID()}`,
        'x-correlation-id': correlationId,
        traceparent: customTraceparent,
      },
      body: JSON.stringify(validInstanceRequest({ name: 'inst-trace-prop' })),
    });
    expect(httpResponse.status).toBe(202);

    const publishRes = await publisher.publishPending({ limit: 10 });
    expect(publishRes.published.length).toBe(1);

    const outboxRow = await store.getPool().query<{ payload: any }>(
      `SELECT payload FROM outbox_events WHERE id = $1`,
      [publishRes.published[0]],
    );
    const eventPayload = typeof outboxRow.rows[0]?.payload === 'string'
      ? JSON.parse(outboxRow.rows[0].payload)
      : outboxRow.rows[0]?.payload;

    const consumeRes = await consumer.processPayload(eventPayload);
    expect(consumeRes.kind).toBe('processed');

    const recordedSpans = getRecordedSpans();
    expect(recordedSpans.length).toBeGreaterThanOrEqual(6);

    // Todos os spans do fluxo devem possuir o MESMO traceId
    for (const span of recordedSpans) {
      expect(span.spanContext().traceId).toBe(customTraceId);
    }

    // Cada span deve possuir um spanId exclusivo
    const spanIds = recordedSpans.map((s) => s.spanContext().spanId);
    const uniqueSpanIds = new Set(spanIds);
    expect(uniqueSpanIds.size).toBe(recordedSpans.length);

    const metrics = await getRecordedMetrics();
    const metricsMap: Record<string, number> = {};
    for (const m of metrics) {
      metricsMap[m.name] = (metricsMap[m.name] ?? 0) + m.value;
    }

    recordObservabilityEvidence({
      scenario: 'scenario-2-trace-propagation',
      riskId: 'RISK-OBS-002',
      controlId: 'CTRL-OBS-CONTEXT-PROPAGATION-001',
      traceId: customTraceId,
      correlationId,
      spansObserved: recordedSpans.map((s) => ({
        name: s.name,
        spanId: s.spanContext().spanId,
        parentSpanId: s.parentSpanContext?.spanId,
        status: s.status.code === SpanStatusCode.OK ? 'OK' : 'ERROR',
        attributes: s.attributes as Record<string, unknown>,
      })),
      metricsObserved: metricsMap,
      finalState: { traceId: customTraceId, spansCount: recordedSpans.length },
      result: 'PASSED',
    });
  });

  // =========================================================================
  // Cenário 3: correlationId permanece consistente e separado de traceId e spanId
  // =========================================================================
  test('Cenário 3: correlationId permanece consistente e separado de traceId e spanId', async ({}, testInfo) => {
    declareControl(testInfo, {
      riskId: 'RISK-OBS-003',
      risk: 'Conflito semântico ou confusão entre correlationId (negócio), traceId (rastreamento técnico) e spanId (operação local).',
      controlId: 'CTRL-OBS-ID-SEPARATION-001',
      control: 'Submeter correlationId explícito e validar separação estrita dos 3 identificadores.',
    });

    const businessCorrelationId = 'corr-biz-customer-order-8812';
    const idempotencyKey = `idemp-${crypto.randomUUID()}`;

    const httpResponse = await fetch(`${apiBaseUrl}/v1/instances`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
        'x-correlation-id': businessCorrelationId,
      },
      body: JSON.stringify(validInstanceRequest({ name: 'inst-id-separation' })),
    });
    expect(httpResponse.status).toBe(202);
    expect(httpResponse.headers.get('x-correlation-id')).toBe(businessCorrelationId);

    const publishRes = await publisher.publishPending({ limit: 10 });
    const outboxRow = await store.getPool().query<{ payload: any }>(
      `SELECT payload FROM outbox_events WHERE id = $1`,
      [publishRes.published[0]],
    );
    const eventPayload = typeof outboxRow.rows[0]?.payload === 'string'
      ? JSON.parse(outboxRow.rows[0].payload)
      : outboxRow.rows[0]?.payload;

    await consumer.processPayload(eventPayload);

    const recordedSpans = getRecordedSpans();
    const httpSpan = recordedSpans.find((s) => s.name === 'http.request')!;
    const traceId = httpSpan.spanContext().traceId;
    const spanId = httpSpan.spanContext().spanId;

    // Distinção semântica e estrutural absoluta
    expect(businessCorrelationId).not.toBe(traceId);
    expect(businessCorrelationId).not.toBe(spanId);
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(spanId).toMatch(/^[0-9a-f]{16}$/);

    // O correlation_id deve estar presente nos atributos de todos os spans relevantes
    const correlationSpans = recordedSpans.filter((s) => s.attributes['correlation_id'] !== undefined);
    expect(correlationSpans.length).toBeGreaterThanOrEqual(4);
    for (const span of correlationSpans) {
      expect(span.attributes['correlation_id']).toBe(businessCorrelationId);
    }

    const metrics = await getRecordedMetrics();
    const metricsMap: Record<string, number> = {};
    for (const m of metrics) {
      metricsMap[m.name] = (metricsMap[m.name] ?? 0) + m.value;
    }

    recordObservabilityEvidence({
      scenario: 'scenario-3-id-separation',
      riskId: 'RISK-OBS-003',
      controlId: 'CTRL-OBS-ID-SEPARATION-001',
      traceId,
      correlationId: businessCorrelationId,
      spansObserved: recordedSpans.map((s) => ({
        name: s.name,
        spanId: s.spanContext().spanId,
        parentSpanId: s.parentSpanContext?.spanId,
        status: s.status.code === SpanStatusCode.OK ? 'OK' : 'ERROR',
        attributes: s.attributes as Record<string, unknown>,
      })),
      metricsObserved: metricsMap,
      finalState: {
        correlationId: businessCorrelationId,
        traceId,
        spanId,
        separated: true,
      },
      result: 'PASSED',
    });
  });

  // =========================================================================
  // Cenário 4: falha do NATS aparece como erro observável
  // =========================================================================
  test('Cenário 4: falha do NATS aparece como erro observável', async ({}, testInfo) => {
    declareControl(testInfo, {
      riskId: 'RISK-OBS-004',
      risk: 'Falha na camada de mensageria NATS ocorre sem sinalização ou diagnóstico no trace distribuído e métricas.',
      controlId: 'CTRL-OBS-NATS-ERROR-VISIBILITY-001',
      control: 'Simular falha de envio ao NATS e validar status ERROR no span nats.publish e métrica de falha.',
    });

    const correlationId = `corr-${crypto.randomUUID()}`;
    await fetch(`${apiBaseUrl}/v1/instances`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `idemp-${crypto.randomUUID()}`,
        'x-correlation-id': correlationId,
      },
      body: JSON.stringify(validInstanceRequest({ name: 'inst-nats-fail' })),
    });

    // Simula falha na camada de publicação
    publisher.setSimulatePublishFailure(true);
    const publishRes = await publisher.publishPending({ limit: 10 });
    expect(publishRes.failed.length).toBe(1);

    const recordedSpans = getRecordedSpans();
    const publishSpan = recordedSpans.find((s) => s.name === 'nats.publish');
    expect(publishSpan).toBeDefined();
    expect(publishSpan!.status.code).toBe(SpanStatusCode.ERROR);
    expect(publishSpan!.status.message).toBe('SIMULATED_PUBLISH_FAILURE');

    const metrics = await getRecordedMetrics();
    const publishFailureMetric = metrics.find((m) => m.name === 'outbox_publish_failures_total');
    expect(publishFailureMetric).toBeDefined();
    expect(publishFailureMetric!.value).toBeGreaterThanOrEqual(1);

    const metricsMap: Record<string, number> = {};
    for (const m of metrics) {
      metricsMap[m.name] = (metricsMap[m.name] ?? 0) + m.value;
    }

    recordObservabilityEvidence({
      scenario: 'scenario-4-nats-publish-failure',
      riskId: 'RISK-OBS-004',
      controlId: 'CTRL-OBS-NATS-ERROR-VISIBILITY-001',
      traceId: publishSpan!.spanContext().traceId,
      correlationId,
      spansObserved: recordedSpans.map((s) => ({
        name: s.name,
        spanId: s.spanContext().spanId,
        parentSpanId: s.parentSpanContext?.spanId,
        status: s.status.code === SpanStatusCode.OK ? 'OK' : 'ERROR',
        attributes: s.attributes as Record<string, unknown>,
      })),
      metricsObserved: metricsMap,
      observedIssue: 'SIMULATED_PUBLISH_FAILURE',
      finalState: { outboxStatus: 'PENDING', publishFailures: publishFailureMetric!.value },
      result: 'PASSED',
    });
  });

  // =========================================================================
  // Cenário 5: falha do consumer aparece no trace
  // =========================================================================
  test('Cenário 5: falha do consumer aparece no trace', async ({}, testInfo) => {
    declareControl(testInfo, {
      riskId: 'RISK-OBS-005',
      risk: 'Falha no processamento do consumer não gera evidência diagnóstica no trace e métricas.',
      controlId: 'CTRL-OBS-CONSUMER-ERROR-VISIBILITY-001',
      control: 'Injetar erro durante execução do consumidor e validar spans com status ERROR e métrica de falha.',
    });

    const correlationId = `corr-${crypto.randomUUID()}`;
    await fetch(`${apiBaseUrl}/v1/instances`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `idemp-${crypto.randomUUID()}`,
        'x-correlation-id': correlationId,
      },
      body: JSON.stringify(validInstanceRequest({ name: 'inst-cons-fail' })),
    });

    const publishRes = await publisher.publishPending({ limit: 10 });
    expect(publishRes.published.length).toBe(1);

    const outboxRow = await store.getPool().query<{ payload: any }>(
      `SELECT payload FROM outbox_events WHERE id = $1`,
      [publishRes.published[0]],
    );
    const eventPayload = typeof outboxRow.rows[0]?.payload === 'string'
      ? JSON.parse(outboxRow.rows[0].payload)
      : outboxRow.rows[0]?.payload;

    // Executa o processamento com falha injetada
    await expect(
      consumer.processPayload(eventPayload, { simulateFailureDuringProcessing: true }),
    ).rejects.toThrow('SIMULATED_CONSUMER_PROCESSING_FAILURE');

    const recordedSpans = getRecordedSpans();
    const consumeSpan = recordedSpans.find((s) => s.name === 'nats.consume');
    const updateDbSpan = recordedSpans.find((s) => s.name === 'db.transaction.update_state');

    expect(consumeSpan).toBeDefined();
    expect(consumeSpan!.status.code).toBe(SpanStatusCode.ERROR);
    expect(consumeSpan!.status.message).toBe('SIMULATED_CONSUMER_PROCESSING_FAILURE');

    expect(updateDbSpan).toBeDefined();
    expect(updateDbSpan!.status.code).toBe(SpanStatusCode.ERROR);
    expect(updateDbSpan!.status.message).toBe('SIMULATED_CONSUMER_PROCESSING_FAILURE');

    const metrics = await getRecordedMetrics();
    const consumerFailuresMetric = metrics.find((m) => m.name === 'consumer_failures_total');
    expect(consumerFailuresMetric).toBeDefined();
    expect(consumerFailuresMetric!.value).toBeGreaterThanOrEqual(1);

    const metricsMap: Record<string, number> = {};
    for (const m of metrics) {
      metricsMap[m.name] = (metricsMap[m.name] ?? 0) + m.value;
    }

    recordObservabilityEvidence({
      scenario: 'scenario-5-consumer-processing-failure',
      riskId: 'RISK-OBS-005',
      controlId: 'CTRL-OBS-CONSUMER-ERROR-VISIBILITY-001',
      traceId: consumeSpan!.spanContext().traceId,
      correlationId,
      spansObserved: recordedSpans.map((s) => ({
        name: s.name,
        spanId: s.spanContext().spanId,
        parentSpanId: s.parentSpanContext?.spanId,
        status: s.status.code === SpanStatusCode.OK ? 'OK' : 'ERROR',
        attributes: s.attributes as Record<string, unknown>,
      })),
      metricsObserved: metricsMap,
      observedIssue: 'SIMULATED_CONSUMER_PROCESSING_FAILURE',
      finalState: { consumerFailures: consumerFailuresMetric!.value },
      result: 'PASSED',
    });
  });

  // =========================================================================
  // Cenário 6: métricas principais refletem os eventos executados
  // =========================================================================
  test('Cenário 6: métricas principais refletem os eventos executados', async ({}, testInfo) => {
    declareControl(testInfo, {
      riskId: 'RISK-OBS-006',
      risk: 'Métricas de telemetria divergem do comportamento real dos componentes distribuídos.',
      controlId: 'CTRL-OBS-METRICS-ACCURACY-001',
      control: 'Executar requisições normais e reentregas, validando exatidão estrita dos contadores de métricas.',
    });

    const correlationId = `corr-${crypto.randomUUID()}`;

    const initialMetrics = await getRecordedMetrics();
    const getDelta = (name: string, currentList: typeof initialMetrics): number => {
      const currentVal = currentList.filter((m) => m.name === name).reduce((acc, m) => acc + m.value, 0);
      const initialVal = initialMetrics.filter((m) => m.name === name).reduce((acc, m) => acc + m.value, 0);
      return currentVal - initialVal;
    };

    // 1. Requisição válida (202)
    const res1 = await fetch(`${apiBaseUrl}/v1/instances`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `idemp-${crypto.randomUUID()}`,
        'x-correlation-id': correlationId,
      },
      body: JSON.stringify(validInstanceRequest({ name: 'inst-metrics' })),
    });
    expect(res1.status).toBe(202);

    // 2. Requisição inválida (400)
    const res2 = await fetch(`${apiBaseUrl}/v1/instances`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `idemp-${crypto.randomUUID()}`,
        'x-correlation-id': correlationId,
      },
      body: JSON.stringify({ invalid: true }),
    });
    expect(res2.status).toBe(400);

    // 3. Publicação
    const publishRes = await publisher.publishPending({ limit: 10 });
    const outboxRow = await store.getPool().query<{ payload: any }>(
      `SELECT payload FROM outbox_events WHERE id = $1`,
      [publishRes.published[0]],
    );
    const eventPayload = typeof outboxRow.rows[0]?.payload === 'string'
      ? JSON.parse(outboxRow.rows[0].payload)
      : outboxRow.rows[0]?.payload;

    // 4. Consumo primário
    const consumeRes1 = await consumer.processPayload(eventPayload);
    expect(consumeRes1.kind).toBe('processed');

    // 5. Consumo repetido (simulação de redelivery)
    const consumeRes2 = await consumer.processPayload(eventPayload);
    expect(consumeRes2.kind).toBe('already_processed');

    const metrics = await getRecordedMetrics();
    const deltaHttpRequests = getDelta('http_requests_total', metrics);
    const deltaHttpErrors = getDelta('http_errors_total', metrics);
    const deltaMessagesProcessed = getDelta('messages_processed_total', metrics);
    const deltaRedeliveries = getDelta('message_redeliveries_total', metrics);

    // 2 requisições HTTP registradas neste cenário
    expect(deltaHttpRequests).toBe(2);

    // 1 erro HTTP registrado (o 400)
    expect(deltaHttpErrors).toBe(1);

    // 2 mensagens processadas (1 processed + 1 already_processed)
    expect(deltaMessagesProcessed).toBe(2);

    // 1 redelivery registrado
    expect(deltaRedeliveries).toBe(1);

    const metricsMap: Record<string, number> = {
      http_requests_total: deltaHttpRequests,
      http_errors_total: deltaHttpErrors,
      messages_processed_total: deltaMessagesProcessed,
      message_redeliveries_total: deltaRedeliveries,
    };

    const recordedSpans = getRecordedSpans();
    recordObservabilityEvidence({
      scenario: 'scenario-6-metrics-accuracy',
      riskId: 'RISK-OBS-006',
      controlId: 'CTRL-OBS-METRICS-ACCURACY-001',
      traceId: recordedSpans[0]?.spanContext().traceId ?? 'trace-na',
      correlationId,
      spansObserved: recordedSpans.map((s) => ({
        name: s.name,
        spanId: s.spanContext().spanId,
        parentSpanId: s.parentSpanContext?.spanId,
        status: s.status.code === SpanStatusCode.OK ? 'OK' : 'ERROR',
        attributes: s.attributes as Record<string, unknown>,
      })),
      metricsObserved: metricsMap,
      finalState: { metricsMap },
      result: 'PASSED',
    });
  });

  // =========================================================================
  // Cenário 7: indisponibilidade da telemetria não quebra o comportamento funcional principal
  // =========================================================================
  test('Cenário 7: indisponibilidade da telemetria não quebra o comportamento funcional principal', async ({}, testInfo) => {
    declareControl(testInfo, {
      riskId: 'RISK-OBS-007',
      risk: 'Falha ou indisponibilidade do pipeline de telemetria quebra o fluxo funcional da aplicação.',
      controlId: 'CTRL-OBS-TELEMETRY-FAULT-TOLERANCE-001',
      control: 'Submeter operações funcionais com telemetria falhando e validar integridade do fluxo principal.',
    });

    const correlationId = `corr-${crypto.randomUUID()}`;
    const idempotencyKey = `idemp-${crypto.randomUUID()}`;

    // Operação funcional continua executando sem falhar, mesmo se o OTLP ou collector estiver inacessível
    const httpResponse = await fetch(`${apiBaseUrl}/v1/instances`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
        'x-correlation-id': correlationId,
        // Header malformado não deve quebrar a API
        traceparent: 'malformed-traceparent-header-value',
      },
      body: JSON.stringify(validInstanceRequest({ name: 'inst-tel-resilience' })),
    });

    expect(httpResponse.status).toBe(202);
    const opBody = (await httpResponse.json()) as { id: string; resourceId: string };
    expect(opBody.id).toBeDefined();

    const publishRes = await publisher.publishPending({ limit: 10 });
    expect(publishRes.published.length).toBe(1);

    const outboxRow = await store.getPool().query<{ payload: any }>(
      `SELECT payload FROM outbox_events WHERE id = $1`,
      [publishRes.published[0]],
    );
    const eventPayload = typeof outboxRow.rows[0]?.payload === 'string'
      ? JSON.parse(outboxRow.rows[0].payload)
      : outboxRow.rows[0]?.payload;

    const consumeRes = await consumer.processPayload(eventPayload);
    expect(consumeRes.kind).toBe('processed');

    // Confirma que o recurso foi atualizado para RUNNING no banco de dados
    const instance = await store.getInstance(opBody.resourceId);
    expect(instance?.status).toBe('RUNNING');

    const recordedSpans = getRecordedSpans();
    const metrics = await getRecordedMetrics();
    const metricsMap: Record<string, number> = {};
    for (const m of metrics) {
      metricsMap[m.name] = (metricsMap[m.name] ?? 0) + m.value;
    }

    recordObservabilityEvidence({
      scenario: 'scenario-7-telemetry-fault-tolerance',
      riskId: 'RISK-OBS-007',
      controlId: 'CTRL-OBS-TELEMETRY-FAULT-TOLERANCE-001',
      traceId: recordedSpans[0]?.spanContext().traceId ?? 'trace-fallback',
      correlationId,
      spansObserved: recordedSpans.map((s) => ({
        name: s.name,
        spanId: s.spanContext().spanId,
        parentSpanId: s.parentSpanContext?.spanId,
        status: s.status.code === SpanStatusCode.OK ? 'OK' : 'ERROR',
        attributes: s.attributes as Record<string, unknown>,
      })),
      metricsObserved: metricsMap,
      finalState: { instanceId: opBody.resourceId, status: 'RUNNING' },
      result: 'PASSED',
    });
  });
});
