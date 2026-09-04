import http from 'node:http';
import type net from 'node:net';
import crypto from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { NatsConnection } from 'nats';

import { declareControl, validInstanceRequest } from '../helpers/quality.js';
import { PostgresControlPlaneStore } from '../../apps/control-plane-mock/src/postgres-store.js';
import { connectNats, ensureStream } from '../../apps/control-plane-mock/src/nats-jetstream.js';
import { OutboxPublisher } from '../../apps/control-plane-mock/src/outbox-publisher.js';
import { EventConsumer } from '../../apps/control-plane-mock/src/consumer.js';
import { createRequestHandler } from '../../apps/control-plane-mock/src/app.js';
import {
  clearRecordedSpans,
  getRecordedSpans,
  clearRecordedMetrics,
} from '../../apps/control-plane-mock/src/telemetry.js';
import {
  evaluateSla,
  recordJourneyEvidence,
  LAB_SYNTHETIC_SLA,
} from '../helpers/journey-evidence.js';

test.describe.serial('LAB-08 — Synthetic & End-to-End Control Plane Journeys', () => {
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

    // Inicia workers assíncronos contínuos em background com loop rápido para simulação fiel
    publisher.start(50);
    await consumer.start();

    // Servidor HTTP em porta efêmera dedicada
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
  // Jornada 1: Provisionamento bem-sucedido de ponta a ponta
  // =========================================================================
  test('Jornada 1: Provisionamento bem-sucedido de ponta a ponta com telemetria e SLA sintético', async ({}, testInfo) => {
    declareControl(testInfo, {
      riskId: 'RISK-JOURNEY-001',
      risk: 'Jornada de provisionamento assíncrono conclui parcialmente ou operação fica retida em estado intermediário sem convergência final.',
      controlId: 'CTRL-JOURNEY-PROVISIONING-001',
      control: 'Executar jornada ponta a ponta desde POST HTTP até estado final SUCCEEDED e RUNNING, validando correlação e SLA.',
    });

    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const idempotencyKey = `journey-prov-${crypto.randomUUID()}`;
    const correlationId = `corr-journey-${crypto.randomUUID()}`;

    // 1. Cliente submete POST /v1/instances
    const res = await fetch(`${apiBaseUrl}/v1/instances`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
        'x-correlation-id': correlationId,
      },
      body: JSON.stringify(validInstanceRequest),
    });

    const acceptedAt = new Date().toISOString();
    const apiLatencyMs = Date.now() - t0;

    expect(res.status).toBe(202);
    const operation = await res.json() as {
      id: string;
      resourceId: string;
      status: string;
    };

    const instanceId = operation.resourceId;
    const operationId = operation.id;
    const traceparent = res.headers.get('traceparent') ?? '';
    const traceId = traceparent.split('-')[1] ?? '';

    expect(instanceId).toBeTruthy();
    expect(operationId).toBeTruthy();
    expect(traceId).toBeTruthy();

    // 2. Acompanhamento assíncrono determinístico da jornada até conclusão
    let finalOperationStatus = 'PENDING';
    await expect.poll(async () => {
      const opRes = await fetch(`${apiBaseUrl}/v1/operations/${operationId}`);
      if (!opRes.ok) return 'UNKNOWN';
      const opData = await opRes.json() as { status: string };
      finalOperationStatus = opData.status;
      return finalOperationStatus;
    }, { timeout: LAB_SYNTHETIC_SLA.maxEndToEndDurationMs, intervals: [50, 100, 200] }).toBe('SUCCEEDED');

    // 3. Validação do estado final da instância
    const instRes = await fetch(`${apiBaseUrl}/v1/instances/${instanceId}`);
    expect(instRes.ok).toBe(true);
    const instData = await instRes.json() as { status: string };
    const finalInstanceStatus = instData.status;
    expect(finalInstanceStatus).toBe('RUNNING');

    const completedAt = new Date().toISOString();
    const endToEndDurationMs = Date.now() - t0;

    // 4. Validação de telemetria da jornada (spans conectados pelo traceId W3C)
    const spans = getRecordedSpans().filter((s) => s.spanContext().traceId === traceId);
    const spanNames = spans.map((s) => s.name);
    expect(spanNames).toContain('http.request');
    expect(spanNames).toContain('db.transaction.create_instance');
    expect(spanNames).toContain('outbox.create_event');
    expect(spanNames).toContain('nats.publish');
    expect(spanNames).toContain('nats.consume');
    expect(spanNames).toContain('db.transaction.update_state');

    // 5. Avaliação de SLA sintético do LAB
    const slaAssessment = evaluateSla({ apiLatencyMs, endToEndDurationMs });
    expect(slaAssessment.apiLatencyMet).toBe(true);
    expect(slaAssessment.endToEndMet).toBe(true);
    expect(slaAssessment.status).toBe('MET');

    // 6. Gravação de evidência estruturada
    recordJourneyEvidence({
      journey: 'journey-1-successful-provisioning',
      riskId: 'RISK-JOURNEY-001',
      controlId: 'CTRL-JOURNEY-PROVISIONING-001',
      startedAt,
      acceptedAt,
      completedAt,
      apiLatencyMs,
      endToEndDurationMs,
      recoveryDurationMs: null,
      traceId,
      correlationId,
      retries: 0,
      redeliveries: 0,
      finalState: {
        instanceId,
        operationId,
        instanceStatus: finalInstanceStatus,
        operationStatus: finalOperationStatus,
      },
      slaAssessment,
      result: 'PASSED',
    });
  });

  // =========================================================================
  // Jornada 2: Retry idempotente durante provisionamento
  // =========================================================================
  test('Jornada 2: Retry idempotente durante provisionamento previne duplicidade e conclui jornada', async ({}, testInfo) => {
    declareControl(testInfo, {
      riskId: 'RISK-JOURNEY-002',
      risk: 'Retry da requisição durante a jornada de provisionamento causa duplicidade de instâncias, operações ou eventos Outbox.',
      controlId: 'CTRL-JOURNEY-IDEMPOTENT-RETRY-001',
      control: 'Submeter retry com mesma Idempotency-Key durante o ciclo assíncrono e verificar idempotência total de ponta a ponta.',
    });

    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const idempotencyKey = `journey-idemp-${crypto.randomUUID()}`;
    const correlationId = `corr-idemp-${crypto.randomUUID()}`;

    // 1. Requisição inicial
    const res1 = await fetch(`${apiBaseUrl}/v1/instances`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
        'x-correlation-id': correlationId,
      },
      body: JSON.stringify(validInstanceRequest),
    });

    const acceptedAt = new Date().toISOString();
    const apiLatencyMs = Date.now() - t0;
    expect(res1.status).toBe(202);
    const op1 = await res1.json() as {
      id: string;
      resourceId: string;
      status: string;
    };
    const instanceId = op1.resourceId;
    const operationId = op1.id;
    const traceparent = res1.headers.get('traceparent') ?? '';
    const traceId = traceparent.split('-')[1] ?? '';

    // 2. Retentativa cliente imediata com a mesma chave e payload
    const res2 = await fetch(`${apiBaseUrl}/v1/instances`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
        'x-correlation-id': correlationId,
      },
      body: JSON.stringify(validInstanceRequest),
    });

    expect(res2.status).toBe(202);
    const op2 = await res2.json() as {
      id: string;
      resourceId: string;
      status: string;
    };
    // Replay deve retornar exatamente a mesma identidade de instância e operação
    expect(op2.resourceId).toBe(instanceId);
    expect(op2.id).toBe(operationId);

    // 3. Acompanhamento determinístico até conclusão
    await expect.poll(async () => {
      const opRes = await fetch(`${apiBaseUrl}/v1/operations/${operationId}`);
      if (!opRes.ok) return 'UNKNOWN';
      const opData = await opRes.json() as { status: string };
      return opData.status;
    }, { timeout: LAB_SYNTHETIC_SLA.maxEndToEndDurationMs, intervals: [50, 100, 200] }).toBe('SUCCEEDED');

    // 4. Verificação de unicidade física no PostgreSQL (sem registros espúrios)
    const pool = store.getPool();
    const countInstances = await pool.query<{ count: string }>('SELECT COUNT(*) FROM instances WHERE id = $1', [instanceId]);
    const countOperations = await pool.query<{ count: string }>('SELECT COUNT(*) FROM operations WHERE id = $1', [operationId]);
    const countOutbox = await pool.query<{ count: string }>('SELECT COUNT(*) FROM outbox_events WHERE correlation_id = $1', [correlationId]);

    expect(Number(countInstances.rows[0]!.count)).toBe(1);
    expect(Number(countOperations.rows[0]!.count)).toBe(1);
    expect(Number(countOutbox.rows[0]!.count)).toBe(1);

    const completedAt = new Date().toISOString();
    const endToEndDurationMs = Date.now() - t0;

    const slaAssessment = evaluateSla({ apiLatencyMs, endToEndDurationMs });
    expect(slaAssessment.apiLatencyMet).toBe(true);
    expect(slaAssessment.endToEndMet).toBe(true);

    recordJourneyEvidence({
      journey: 'journey-2-idempotent-retry',
      riskId: 'RISK-JOURNEY-002',
      controlId: 'CTRL-JOURNEY-IDEMPOTENT-RETRY-001',
      startedAt,
      acceptedAt,
      completedAt,
      apiLatencyMs,
      endToEndDurationMs,
      recoveryDurationMs: null,
      traceId,
      correlationId,
      retries: 1,
      redeliveries: 0,
      finalState: {
        instanceId,
        operationId,
        instanceStatus: 'RUNNING',
        operationStatus: 'SUCCEEDED',
        uniqueInstanceCount: 1,
        uniqueOperationCount: 1,
        uniqueOutboxEventCount: 1,
      },
      slaAssessment,
      result: 'PASSED',
    });
  });

  // =========================================================================
  // Jornada 3: Falha temporária de NATS com recuperação
  // =========================================================================
  test('Jornada 3: Falha temporária de NATS com recuperação assíncrona cumpre SLA e converge', async ({}, testInfo) => {
    declareControl(testInfo, {
      riskId: 'RISK-JOURNEY-003',
      risk: 'Indisponibilidade transitória do broker NATS bloqueia a aceitação da API ou impede a convergência da jornada após a recuperação.',
      controlId: 'CTRL-JOURNEY-BROKER-RECOVERY-001',
      control: 'Injetar falha temporária de NATS, validar aceitação desacoplada da API, retenção no Outbox e convergência pós-restabelecimento.',
    });

    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const idempotencyKey = `journey-broker-${crypto.randomUUID()}`;
    const correlationId = `corr-broker-fail-${crypto.randomUUID()}`;

    // 1. Simulação de falha temporária de envio ao NATS
    publisher.setSimulatePublishFailure(true);

    // 2. Chamada de API deve ser desacoplada e aceitar em tempo hábil (<= 500ms)
    const res = await fetch(`${apiBaseUrl}/v1/instances`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
        'x-correlation-id': correlationId,
      },
      body: JSON.stringify(validInstanceRequest),
    });

    const acceptedAt = new Date().toISOString();
    const apiLatencyMs = Date.now() - t0;
    expect(res.status).toBe(202);

    const operation = await res.json() as {
      id: string;
      resourceId: string;
      status: string;
    };
    const instanceId = operation.resourceId;
    const operationId = operation.id;
    const traceparent = res.headers.get('traceparent') ?? '';
    const traceId = traceparent.split('-')[1] ?? '';

    // 3. Comprovar degradação: evento é retido como PENDING com erro no Outbox
    const pool = store.getPool();
    await expect.poll(async () => {
      const outboxRow = await pool.query<{ status: string; retry_count: number; last_error: string }>(
        'SELECT status, retry_count, last_error FROM outbox_events WHERE correlation_id = $1',
        [correlationId],
      );
      if (outboxRow.rows.length === 0) return 'NONE';
      return `${outboxRow.rows[0]!.status}-${outboxRow.rows[0]!.last_error}`;
    }, { timeout: 3000, intervals: [50, 100] }).toBe('PENDING-SIMULATED_PUBLISH_FAILURE');

    // 4. Restabelecimento do NATS (recuperação)
    const tRecoveryStart = Date.now();
    publisher.setSimulatePublishFailure(false);

    // 5. Convergência da operação após retorno do publisher
    await expect.poll(async () => {
      const opRes = await fetch(`${apiBaseUrl}/v1/operations/${operationId}`);
      if (!opRes.ok) return 'UNKNOWN';
      const opData = await opRes.json() as { status: string };
      return opData.status;
    }, { timeout: LAB_SYNTHETIC_SLA.maxRecoveryDurationMs, intervals: [50, 100, 200] }).toBe('SUCCEEDED');

    const completedAt = new Date().toISOString();
    const recoveryDurationMs = Date.now() - tRecoveryStart;
    const endToEndDurationMs = Date.now() - t0;

    const slaAssessment = evaluateSla({ apiLatencyMs, endToEndDurationMs, recoveryDurationMs });
    expect(slaAssessment.apiLatencyMet).toBe(true);
    expect(slaAssessment.recoveryMet).toBe(true);
    expect(slaAssessment.endToEndMet).toBe(true);

    recordJourneyEvidence({
      journey: 'journey-3-transient-nats-failure-recovery',
      riskId: 'RISK-JOURNEY-003',
      controlId: 'CTRL-JOURNEY-BROKER-RECOVERY-001',
      startedAt,
      acceptedAt,
      completedAt,
      apiLatencyMs,
      endToEndDurationMs,
      recoveryDurationMs,
      traceId,
      correlationId,
      retries: 1,
      redeliveries: 0,
      finalState: {
        instanceId,
        operationId,
        instanceStatus: 'RUNNING',
        operationStatus: 'SUCCEEDED',
        recoveryObserved: true,
      },
      slaAssessment,
      result: 'PASSED',
    });
  });

  // =========================================================================
  // Jornada 4: Falha do consumer com redelivery
  // =========================================================================
  test('Jornada 4: Falha do consumer com redelivery previne ACK prematuro e converge estado', async ({}, testInfo) => {
    declareControl(testInfo, {
      riskId: 'RISK-JOURNEY-004',
      risk: 'Falha no processamento do consumidor confirma ACK prematuramente ou reentrega viola a consistência final da jornada.',
      controlId: 'CTRL-JOURNEY-CONSUMER-REDELIVERY-001',
      control: 'Injetar falha controlada na primeira tentativa do consumidor, validar retenção atômica e convergência após redelivery.',
    });

    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const idempotencyKey = `journey-consumer-${crypto.randomUUID()}`;
    const correlationId = `corr-consumer-fail-${crypto.randomUUID()}`;

    // 1. Simular falha transitória do consumidor na primeira entrega
    consumer.setSimulateFailure(true);

    // 2. Requisição aceita pela API
    const res = await fetch(`${apiBaseUrl}/v1/instances`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
        'x-correlation-id': correlationId,
      },
      body: JSON.stringify(validInstanceRequest),
    });

    const acceptedAt = new Date().toISOString();
    const apiLatencyMs = Date.now() - t0;
    expect(res.status).toBe(202);

    const operation = await res.json() as {
      id: string;
      resourceId: string;
      status: string;
    };
    const instanceId = operation.resourceId;
    const operationId = operation.id;
    const traceparent = res.headers.get('traceparent') ?? '';
    const traceId = traceparent.split('-')[1] ?? '';

    // 3. Comprovar que o consumidor falhou sem confirmar ACK prematuro (processed_events permanece vazio)
    const pool = store.getPool();
    await expect.poll(async () => {
      const processed = await pool.query<{ count: string }>('SELECT COUNT(*) FROM processed_events');
      const opRes = await fetch(`${apiBaseUrl}/v1/operations/${operationId}`);
      const opData = await opRes.json() as { status: string };
      return `${processed.rows[0]!.count}-${opData.status}`;
    }, { timeout: 3000, intervals: [50, 100] }).toBe('0-PENDING');

    // 4. Restabelecimento do consumidor e recebimento do redelivery
    const tRecoveryStart = Date.now();
    consumer.setSimulateFailure(false);

    // 5. Convergência da operação para SUCCEEDED após redelivery
    await expect.poll(async () => {
      const opRes = await fetch(`${apiBaseUrl}/v1/operations/${operationId}`);
      if (!opRes.ok) return 'UNKNOWN';
      const opData = await opRes.json() as { status: string };
      return opData.status;
    }, { timeout: LAB_SYNTHETIC_SLA.maxRecoveryDurationMs, intervals: [50, 100, 200] }).toBe('SUCCEEDED');

    // 6. Validar que exatamente 1 evento foi registrado em processed_events
    const finalProcessed = await pool.query<{ count: string }>('SELECT COUNT(*) FROM processed_events');
    expect(Number(finalProcessed.rows[0]!.count)).toBe(1);

    const completedAt = new Date().toISOString();
    const recoveryDurationMs = Date.now() - tRecoveryStart;
    const endToEndDurationMs = Date.now() - t0;

    const slaAssessment = evaluateSla({ apiLatencyMs, endToEndDurationMs, recoveryDurationMs });
    expect(slaAssessment.apiLatencyMet).toBe(true);
    expect(slaAssessment.recoveryMet).toBe(true);

    recordJourneyEvidence({
      journey: 'journey-4-consumer-failure-redelivery',
      riskId: 'RISK-JOURNEY-004',
      controlId: 'CTRL-JOURNEY-CONSUMER-REDELIVERY-001',
      startedAt,
      acceptedAt,
      completedAt,
      apiLatencyMs,
      endToEndDurationMs,
      recoveryDurationMs,
      traceId,
      correlationId,
      retries: 0,
      redeliveries: 1,
      finalState: {
        instanceId,
        operationId,
        instanceStatus: 'RUNNING',
        operationStatus: 'SUCCEEDED',
        processedEventCount: 1,
      },
      slaAssessment,
      result: 'PASSED',
    });
  });
});
