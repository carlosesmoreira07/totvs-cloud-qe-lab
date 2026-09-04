import { expect, test } from '@playwright/test';
import crypto from 'node:crypto';
import type { NatsConnection } from 'nats';
import { declareControl, validInstanceRequest } from '../helpers/quality.js';
import { PostgresControlPlaneStore } from '../../apps/control-plane-mock/src/postgres-store.js';
import { connectNats, ensureStream } from '../../apps/control-plane-mock/src/nats-jetstream.js';
import { OutboxPublisher } from '../../apps/control-plane-mock/src/outbox-publisher.js';
import { EventConsumer } from '../../apps/control-plane-mock/src/consumer.js';

test.describe.serial('LAB-05 — PostgreSQL + Transactional Outbox + NATS JetStream', () => {
  let store: PostgresControlPlaneStore;
  let nc: NatsConnection;
  let publisher: OutboxPublisher;
  let consumer: EventConsumer;

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
  });

  test.afterAll(async () => {
    publisher?.stop();
    if (consumer) {
      await consumer.stop();
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
  });

  test('transação cria domínio + Outbox atomicamente', async ({}, testInfo) => {
    declareControl(testInfo, {
      riskId: 'RISK-OUTBOX-001',
      risk: 'Persistência confirmada sem evento Outbox ou divergência atômica entre domínio e evento.',
      controlId: 'CTRL-OUTBOX-ATOMIC-001',
      control: 'Criar instância no PostgreSQL e validar presença atômica em instances, operations e outbox_events.',
    });

    const key = `atomic-${crypto.randomUUID()}`;
    const correlationId = `corr-${crypto.randomUUID()}`;

    const createResult = await store.createInstance(validInstanceRequest, key, correlationId);
    expect(createResult.kind).toBe('created');
    if (createResult.kind !== 'created') return;

    const pool = store.getPool();

    // 1. Instância persistida com status PROVISIONING
    const instanceResult = await pool.query(
      `SELECT id, status, name, region, image, flavor FROM instances WHERE id = $1`,
      [createResult.operation.resourceId],
    );
    expect(instanceResult.rows).toHaveLength(1);
    expect(instanceResult.rows[0]).toMatchObject({
      id: createResult.operation.resourceId,
      status: 'PROVISIONING',
      name: validInstanceRequest.name,
      region: validInstanceRequest.region,
    });

    // 2. Operação persistida com status PENDING
    const opResult = await pool.query(
      `SELECT id, type, status, resource_id, correlation_id FROM operations WHERE id = $1`,
      [createResult.operation.id],
    );
    expect(opResult.rows).toHaveLength(1);
    expect(opResult.rows[0]).toMatchObject({
      id: createResult.operation.id,
      type: 'PROVISION_INSTANCE',
      status: 'PENDING',
      resource_id: createResult.operation.resourceId,
      correlation_id: correlationId,
    });

    // 3. Evento Outbox registrado na MESMA transação
    const outboxResult = await pool.query(
      `SELECT id, event_type, aggregate_type, aggregate_id, correlation_id, payload, status, retry_count
       FROM outbox_events WHERE aggregate_id = $1`,
      [createResult.operation.resourceId],
    );
    expect(outboxResult.rows).toHaveLength(1);
    const eventRow = outboxResult.rows[0];
    expect(eventRow).toMatchObject({
      event_type: 'instance.provisioning.requested',
      aggregate_type: 'instance',
      aggregate_id: createResult.operation.resourceId,
      correlation_id: correlationId,
      status: 'PENDING',
      retry_count: 0,
    });

    const payload = typeof eventRow.payload === 'string' ? JSON.parse(eventRow.payload) : eventRow.payload;
    expect(payload).toMatchObject({
      eventId: eventRow.id,
      instanceId: createResult.operation.resourceId,
      operationId: createResult.operation.id,
      correlationId,
    });
    expect(payload.occurredAt).toBeTruthy();
  });

  test('falha simulada de publish mantém evento pendente', async ({}, testInfo) => {
    declareControl(testInfo, {
      riskId: 'RISK-OUTBOX-002',
      risk: 'Falha temporária de publicação descarta o evento ou impede retries posteriores.',
      controlId: 'CTRL-OUTBOX-RETRY-001',
      control: 'Simular falha de envio ao NATS, exigir status PENDING com retry_count incrementado e republicar com sucesso.',
    });

    const key = `publish-fail-${crypto.randomUUID()}`;
    const correlationId = `corr-${crypto.randomUUID()}`;
    const createResult = await store.createInstance(validInstanceRequest, key, correlationId);
    expect(createResult.kind).toBe('created');

    // Executa publisher com falha simulada de envio ao NATS
    const publishResult = await publisher.publishPending({ simulatePublishFailure: true });
    expect(publishResult.total).toBe(1);
    expect(publishResult.failed).toHaveLength(1);
    expect(publishResult.published).toHaveLength(0);

    const pool = store.getPool();
    const eventResult = await pool.query(
      `SELECT status, retry_count, last_error, published_at FROM outbox_events WHERE correlation_id = $1`,
      [correlationId],
    );

    expect(eventResult.rows).toHaveLength(1);
    const event = eventResult.rows[0];
    expect(event.status).toBe('PENDING');
    expect(event.retry_count).toBe(1);
    expect(event.last_error).toBe('SIMULATED_PUBLISH_FAILURE');
    expect(event.published_at).toBeNull();
  });

  test('retry publica depois', async ({}, testInfo) => {
    declareControl(testInfo, {
      riskId: 'RISK-OUTBOX-002',
      risk: 'Falha temporária de publicação descarta o evento ou impede retries posteriores.',
      controlId: 'CTRL-OUTBOX-RETRY-001',
      control: 'Simular falha de envio ao NATS, exigir status PENDING com retry_count incrementado e republicar com sucesso.',
    });

    const key = `retry-success-${crypto.randomUUID()}`;
    const correlationId = `corr-${crypto.randomUUID()}`;
    await store.createInstance(validInstanceRequest, key, correlationId);

    // 1. Primeira tentativa falha de forma controlada
    await publisher.publishPending({ simulatePublishFailure: true });

    // 2. Retry com publicação normal
    const retryResult = await publisher.publishPending({ simulatePublishFailure: false });
    expect(retryResult.published).toHaveLength(1);
    expect(retryResult.failed).toHaveLength(0);

    const pool = store.getPool();
    const eventResult = await pool.query(
      `SELECT status, retry_count, last_error, published_at FROM outbox_events WHERE correlation_id = $1`,
      [correlationId],
    );

    expect(eventResult.rows).toHaveLength(1);
    const event = eventResult.rows[0];
    expect(event.status).toBe('PUBLISHED');
    expect(event.retry_count).toBe(1);
    expect(event.last_error).toBeNull();
    expect(event.published_at).not.toBeNull();
  });

  test('evento publicado não é publicado novamente indevidamente', async ({}, testInfo) => {
    declareControl(testInfo, {
      riskId: 'RISK-OUTBOX-003',
      risk: 'Evento já confirmado é reenviado em novos ciclos, gerando duplicidade desnecessária.',
      controlId: 'CTRL-OUTBOX-DEDUP-001',
      control: 'Executar novo ciclo do publisher e garantir que eventos PUBLISHED sejam ignorados.',
    });

    const key = `dedup-publish-${crypto.randomUUID()}`;
    const correlationId = `corr-${crypto.randomUUID()}`;
    await store.createInstance(validInstanceRequest, key, correlationId);

    // Publica com sucesso
    const firstPublish = await publisher.publishPending();
    expect(firstPublish.published).toHaveLength(1);

    // Executa novo ciclo do publisher
    const secondPublish = await publisher.publishPending();
    expect(secondPublish.total).toBe(0);
    expect(secondPublish.published).toHaveLength(0);
    expect(secondPublish.failed).toHaveLength(0);

    const pool = store.getPool();
    const countResult = await pool.query(
      `SELECT COUNT(*)::int as count FROM outbox_events WHERE status = 'PUBLISHED'`,
    );
    expect(countResult.rows[0].count).toBe(1);
  });

  test('consumer duplicado não duplica efeito', async ({}, testInfo) => {
    declareControl(testInfo, {
      riskId: 'RISK-CONSUMER-001',
      risk: 'Reentrega de mensagem no modelo at-least-once duplica processamento ou altera estado indevidamente.',
      controlId: 'CTRL-CONSUMER-IDEMPOTENT-001',
      control: 'Processar o mesmo evento duas vezes e verificar detecção em processed_events e estado preservado.',
    });

    const key = `dup-consumer-${crypto.randomUUID()}`;
    const correlationId = `corr-${crypto.randomUUID()}`;
    const createResult = await store.createInstance(validInstanceRequest, key, correlationId);
    expect(createResult.kind).toBe('created');
    if (createResult.kind !== 'created') return;

    const events = await store.getPendingOutboxEvents(1);
    expect(events).toHaveLength(1);
    const event = events[0]!;

    // 1. Primeiro processamento pelo consumer
    const firstResult = await consumer.processPayload(event.payload);
    expect(firstResult.kind).toBe('processed');

    const pool = store.getPool();
    const opFirst = await pool.query<{ status: string; updated_at: Date }>(
      `SELECT status, updated_at FROM operations WHERE id = $1`,
      [createResult.operation.id],
    );
    expect(opFirst.rows[0]!.status).toBe('SUCCEEDED');
    const firstTimestamp = opFirst.rows[0]!.updated_at.getTime();

    const instFirst = await pool.query<{ status: string }>(
      `SELECT status FROM instances WHERE id = $1`,
      [createResult.operation.resourceId],
    );
    expect(instFirst.rows[0]!.status).toBe('RUNNING');

    // 2. Segundo processamento (simulação de redelivery / at-least-once)
    const secondResult = await consumer.processPayload(event.payload);
    expect(secondResult.kind).toBe('already_processed');

    // 3. Validar que não houve alteração no estado nem duplicação
    const opSecond = await pool.query<{ status: string; updated_at: Date }>(
      `SELECT status, updated_at FROM operations WHERE id = $1`,
      [createResult.operation.id],
    );
    expect(opSecond.rows[0]!.status).toBe('SUCCEEDED');
    expect(opSecond.rows[0]!.updated_at.getTime()).toBe(firstTimestamp);

    const processedCount = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int as count FROM processed_events WHERE event_id = $1`,
      [event.payload.eventId],
    );
    expect(processedCount.rows[0]!.count).toBe(1);
  });

  test('correlationId atravessa API → DB → Outbox → NATS → consumer', async ({}, testInfo) => {
    declareControl(testInfo, {
      riskId: 'RISK-EVENT-001',
      risk: 'Perda de rastreabilidade ou correlação na cadeia assíncrona distribuída.',
      controlId: 'CTRL-EVENT-TRACE-001',
      control: 'Rastrear correlationId da API até instâncias, operações, outbox, mensagem NATS e log do consumer.',
    });

    const key = `trace-${crypto.randomUUID()}`;
    const traceCorrelationId = `trace-id-${crypto.randomUUID()}`;

    // 1. API / DB: Criação preserva correlationId
    const createResult = await store.createInstance(validInstanceRequest, key, traceCorrelationId);
    expect(createResult.kind).toBe('created');
    if (createResult.kind !== 'created') return;

    const op = await store.getOperation(createResult.operation.id);
    expect(op?.correlationId).toBe(traceCorrelationId);

    // 2. Outbox: Evento armazena correlationId no registro e no payload
    const pending = await store.getPendingOutboxEvents(1);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.correlationId).toBe(traceCorrelationId);
    expect(pending[0]!.payload.correlationId).toBe(traceCorrelationId);

    // 3. NATS JetStream: Publicar evento e verificar mensagem recebida com correlationId intacto
    const publishResult = await publisher.publishPending();
    expect(publishResult.published).toHaveLength(1);

    // 4. Consumer: Processar payload recebido mantendo correlação
    const processResult = await consumer.processPayload(pending[0]!.payload);
    expect(processResult.kind).toBe('processed');

    // 5. Verificar estado final no banco de dados com correlationId inalterado
    const finalOp = await store.getOperation(createResult.operation.id);
    expect(finalOp?.status).toBe('SUCCEEDED');
    expect(finalOp?.correlationId).toBe(traceCorrelationId);
  });

  test('estado final fica consistente após processamento', async ({}, testInfo) => {
    declareControl(testInfo, {
      riskId: 'RISK-OUTBOX-001',
      risk: 'Operação assíncrona ou instância fica presa em estado intermediário após término do processamento.',
      controlId: 'CTRL-OUTBOX-ATOMIC-001',
      control: 'Concluir fluxo completo Publisher -> JetStream -> Consumer e validar consistência eventual via polling.',
    });

    const key = `e2e-${crypto.randomUUID()}`;
    const correlationId = `corr-e2e-${crypto.randomUUID()}`;

    const createResult = await store.createInstance(validInstanceRequest, key, correlationId);
    expect(createResult.kind).toBe('created');
    if (createResult.kind !== 'created') return;

    // Inicializa consumer no JetStream
    await consumer.start();

    // Publica evento pendente no NATS
    const publishResult = await publisher.publishPending();
    expect(publishResult.published).toHaveLength(1);

    // Polling explícito com timeout aguardando estado final consistente
    await expect
      .poll(
        async () => {
          const op = await store.getOperation(createResult.operation.id);
          return op?.status;
        },
        { timeout: 5000, intervals: [50, 100, 200] },
      )
      .toBe('SUCCEEDED');

    await expect
      .poll(
        async () => {
          const inst = await store.getInstance(createResult.operation.resourceId);
          return inst?.status;
        },
        { timeout: 5000, intervals: [50, 100, 200] },
      )
      .toBe('RUNNING');

    const opFinal = await store.getOperation(createResult.operation.id);
    const instFinal = await store.getInstance(createResult.operation.resourceId);

    expect(opFinal?.status).toBe('SUCCEEDED');
    expect(opFinal?.resourceId).toBe(instFinal?.id);
    expect(instFinal?.status).toBe('RUNNING');
    expect(opFinal?.correlationId).toBe(correlationId);
  });
});
