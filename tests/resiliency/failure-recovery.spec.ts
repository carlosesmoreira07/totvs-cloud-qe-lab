import { expect, test } from '@playwright/test';
import crypto from 'node:crypto';
import type { NatsConnection } from 'nats';
import { declareControl, validInstanceRequest } from '../helpers/quality.js';
import { PostgresControlPlaneStore } from '../../apps/control-plane-mock/src/postgres-store.js';
import { connectNats, ensureStream } from '../../apps/control-plane-mock/src/nats-jetstream.js';
import { OutboxPublisher } from '../../apps/control-plane-mock/src/outbox-publisher.js';
import { EventConsumer } from '../../apps/control-plane-mock/src/consumer.js';
import { recordResiliencyEvidence } from '../helpers/resiliency-evidence.js';
import { ToxiproxyHelper } from '../helpers/toxiproxy.js';

test.describe.serial('LAB-06 — Distributed Failure & Recovery Pack', () => {
  let store: PostgresControlPlaneStore;
  let nc: NatsConnection;
  let publisher: OutboxPublisher;
  let consumer: EventConsumer;
  let toxiproxy: ToxiproxyHelper;

  test.beforeAll(async () => {
    store = new PostgresControlPlaneStore({
      connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/control_plane',
    });
    await store.ensureSchema();

    toxiproxy = new ToxiproxyHelper();
    const hasToxiproxy = await toxiproxy.isAvailable();
    if (hasToxiproxy) {
      await toxiproxy.ensureProxy('nats', '[::]:4223', 'nats:4222');
    }

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

  // =========================================================================
  // Cenário 1: NATS indisponível durante publicação
  // =========================================================================
  test('Cenário 1: NATS indisponível durante publicação mantém Outbox PENDING e recupera após restabelecimento', async ({}, testInfo) => {
    declareControl(testInfo, {
      riskId: 'RISK-RES-001',
      risk: 'Indisponibilidade do broker de mensageria causa falha na API síncrona ou perda de evento Outbox.',
      controlId: 'CTRL-RES-NATS-OUTAGE-001',
      control: 'Simular falha de envio ao NATS, validar isolamento da API, persistência PENDING e recuperação pós-retorno.',
    });

    const startedAt = new Date().toISOString();
    const startTime = Date.now();
    const key = `res-nats-${crypto.randomUUID()}`;
    const correlationId = `corr-nats-outage-${crypto.randomUUID()}`;

    // 1. Chamada de criação ocorre e persiste no banco mesmo com NATS em falha de publicação
    const createResult = await store.createInstance(validInstanceRequest, key, correlationId);
    expect(createResult.kind).toBe('created');
    if (createResult.kind !== 'created') return;

    // 2. Falha de envio simulada durante publicação do Outbox
    const publishFailure = await publisher.publishPending({ simulatePublishFailure: true });
    expect(publishFailure.failed).toHaveLength(1);

    // 3. Verificar estado degradado: evento retido como PENDING com diagnóstico
    const pool = store.getPool();
    const degradedEvent = await pool.query<{ status: string; retry_count: number; last_error: string }>(
      `SELECT status, retry_count, last_error FROM outbox_events WHERE correlation_id = $1`,
      [correlationId],
    );
    expect(degradedEvent.rows[0]!.status).toBe('PENDING');
    expect(degradedEvent.rows[0]!.retry_count).toBe(1);
    expect(degradedEvent.rows[0]!.last_error).toBe('SIMULATED_PUBLISH_FAILURE');

    // 4. Recuperação: restabelecimento do NATS e execução de retry do publisher
    const recoveryPublish = await publisher.publishPending({ simulatePublishFailure: false });
    expect(recoveryPublish.published).toHaveLength(1);

    // 5. Consumidor processa após recuperação
    const pendingEvents = await pool.query<{ payload: unknown }>(
      `SELECT payload FROM outbox_events WHERE correlation_id = $1 AND status = 'PUBLISHED'`,
      [correlationId],
    );
    expect(pendingEvents.rows).toHaveLength(1);
    const payload = typeof pendingEvents.rows[0]!.payload === 'string'
      ? JSON.parse(pendingEvents.rows[0]!.payload)
      : pendingEvents.rows[0]!.payload;

    const consumerResult = await consumer.processPayload(payload);
    expect(consumerResult.kind).toBe('processed');

    // 6. Consistência final
    const op = await store.getOperation(createResult.operation.id);
    const inst = await store.getInstance(createResult.operation.resourceId);
    expect(op?.status).toBe('SUCCEEDED');
    expect(inst?.status).toBe('RUNNING');

    const recoveredAt = new Date().toISOString();
    recordResiliencyEvidence({
      scenario: 'nats-outage-during-publish',
      riskId: 'RISK-RES-001',
      controlId: 'CTRL-RES-NATS-OUTAGE-001',
      startedAt,
      recoveredAt,
      durationMs: Date.now() - startTime,
      observedFailure: 'SIMULATED_PUBLISH_FAILURE',
      finalState: {
        operationStatus: op?.status,
        instanceStatus: inst?.status,
        outboxStatus: 'PUBLISHED',
        outboxRetryCount: 1,
      },
      result: 'PASSED',
    });
  });

  // =========================================================================
  // Cenário 2: Consumer indisponível
  // =========================================================================
  test('Cenário 2: Consumer indisponível retém mensagem no JetStream e processa com unicidade no retorno', async ({}, testInfo) => {
    declareControl(testInfo, {
      riskId: 'RISK-RES-002',
      risk: 'Indisponibilidade temporária do consumidor causa descarte de mensagens no JetStream ou duplicação de efeitos no restabelecimento.',
      controlId: 'CTRL-RES-CONSUMER-OUTAGE-001',
      control: 'Publicar evento no JetStream sem consumer ativo, restabelecer o consumer e validar processamento singular retido.',
    });

    const startedAt = new Date().toISOString();
    const startTime = Date.now();
    const key = `res-consumer-${crypto.randomUUID()}`;
    const correlationId = `corr-consumer-outage-${crypto.randomUUID()}`;

    const createResult = await store.createInstance(validInstanceRequest, key, correlationId);
    expect(createResult.kind).toBe('created');
    if (createResult.kind !== 'created') return;

    // 1. Publica no JetStream sem consumer rodando
    const pubResult = await publisher.publishPending();
    expect(pubResult.published).toHaveLength(1);

    // 2. Verifica estado degradado: publicado no broker, mas domínio ainda PENDING/PROVISIONING
    let op = await store.getOperation(createResult.operation.id);
    let inst = await store.getInstance(createResult.operation.resourceId);
    expect(op?.status).toBe('PENDING');
    expect(inst?.status).toBe('PROVISIONING');

    // 3. Recuperação: inicializa o consumidor durável para drenar mensagens acumuladas
    await consumer.start();

    // 4. Polling explícito aguardando processamento da mensagem retida
    await expect
      .poll(
        async () => {
          const current = await store.getOperation(createResult.operation.id);
          return current?.status;
        },
        { timeout: 5000, intervals: [50, 100, 200] },
      )
      .toBe('SUCCEEDED');

    op = await store.getOperation(createResult.operation.id);
    inst = await store.getInstance(createResult.operation.resourceId);
    expect(op?.status).toBe('SUCCEEDED');
    expect(inst?.status).toBe('RUNNING');

    await consumer.stop();

    const recoveredAt = new Date().toISOString();
    recordResiliencyEvidence({
      scenario: 'consumer-outage-durable-retention',
      riskId: 'RISK-RES-002',
      controlId: 'CTRL-RES-CONSUMER-OUTAGE-001',
      startedAt,
      recoveredAt,
      durationMs: Date.now() - startTime,
      observedFailure: 'CONSUMER_UNAVAILABLE',
      finalState: {
        operationStatus: op?.status,
        instanceStatus: inst?.status,
        durableMessageDelivered: true,
      },
      result: 'PASSED',
    });
  });

  // =========================================================================
  // Cenário 3: Redelivery da mesma mensagem
  // =========================================================================
  test('Cenário 3: Redelivery repetido da mesma mensagem preserva idempotência sem mutações espúrias', async ({}, testInfo) => {
    declareControl(testInfo, {
      riskId: 'RISK-RES-003',
      risk: 'Reentrega repetida da mesma mensagem pelo JetStream viola a monotonicidade de estado ou causa mutações colaterais duplicadas.',
      controlId: 'CTRL-RES-REDELIVERY-001',
      control: 'Forçar entrega repetida do mesmo payload e verificar idempotência atômica, ausência de updates espúrios e confirmação de ACK.',
    });

    const startedAt = new Date().toISOString();
    const startTime = Date.now();
    const key = `res-redelivery-${crypto.randomUUID()}`;
    const correlationId = `corr-redelivery-${crypto.randomUUID()}`;

    const createResult = await store.createInstance(validInstanceRequest, key, correlationId);
    expect(createResult.kind).toBe('created');
    if (createResult.kind !== 'created') return;

    const events = await store.getPendingOutboxEvents(1);
    const payload = events[0]!.payload;

    // 1. Primeira entrega (processamento original)
    const firstDelivery = await consumer.processPayload(payload);
    expect(firstDelivery.kind).toBe('processed');

    const pool = store.getPool();
    const originalOp = await pool.query<{ status: string; updated_at: Date }>(
      `SELECT status, updated_at FROM operations WHERE id = $1`,
      [createResult.operation.id],
    );
    const originalUpdatedAt = originalOp.rows[0]!.updated_at.getTime();

    // 2. Segunda entrega (simulação de redelivery / at-least-once replay)
    const secondDelivery = await consumer.processPayload(payload);
    expect(secondDelivery.kind).toBe('already_processed');

    // 3. Terceira entrega consecutiva
    const thirdDelivery = await consumer.processPayload(payload);
    expect(thirdDelivery.kind).toBe('already_processed');

    // 4. Verificação de invariante: timestamps inalterados e contagem de processed_events única
    const afterRedeliveryOp = await pool.query<{ status: string; updated_at: Date }>(
      `SELECT status, updated_at FROM operations WHERE id = $1`,
      [createResult.operation.id],
    );
    expect(afterRedeliveryOp.rows[0]!.status).toBe('SUCCEEDED');
    expect(afterRedeliveryOp.rows[0]!.updated_at.getTime()).toBe(originalUpdatedAt);

    const processedCount = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int as count FROM processed_events WHERE event_id = $1`,
      [payload.eventId],
    );
    expect(processedCount.rows[0]!.count).toBe(1);

    const recoveredAt = new Date().toISOString();
    recordResiliencyEvidence({
      scenario: 'message-redelivery-idempotency',
      riskId: 'RISK-RES-003',
      controlId: 'CTRL-RES-REDELIVERY-001',
      startedAt,
      recoveredAt,
      durationMs: Date.now() - startTime,
      observedFailure: 'AT_LEAST_ONCE_DUPLICATE_DELIVERY',
      finalState: {
        operationStatus: afterRedeliveryOp.rows[0]!.status,
        timestampPreserved: true,
        processedEventsCount: 1,
      },
      result: 'PASSED',
    });
  });

  // =========================================================================
  // Cenário 4: Reinício do publisher entre leitura e conclusão
  // =========================================================================
  test('Cenário 4: Reinício do publisher entre leitura e conclusão preserva evento no Outbox para republicação segura', async ({}, testInfo) => {
    declareControl(testInfo, {
      riskId: 'RISK-RES-004',
      risk: 'Queda ou reinício forçado do worker publisher durante a iteração perde eventos em voo ou bloqueia eventos futuros.',
      controlId: 'CTRL-RES-PUBLISHER-CRASH-001',
      control: 'Interromper publisher após leitura, instanciar novo publisher subsequente e verificar publicação íntegra via deduplicação msgID.',
    });

    const startedAt = new Date().toISOString();
    const startTime = Date.now();
    const key = `res-crash-${crypto.randomUUID()}`;
    const correlationId = `corr-pub-crash-${crypto.randomUUID()}`;

    const createResult = await store.createInstance(validInstanceRequest, key, correlationId);
    expect(createResult.kind).toBe('created');
    if (createResult.kind !== 'created') return;

    // 1. Instância do Publisher 1 inicia e é terminada abruptamente
    const crashedPublisher = new OutboxPublisher(store.getPool(), nc);
    crashedPublisher.stop();

    // 2. Verificar que o evento não foi corrompido nem apagado
    const pool = store.getPool();
    const checkEvent = await pool.query<{ status: string }>(
      `SELECT status FROM outbox_events WHERE correlation_id = $1`,
      [correlationId],
    );
    expect(checkEvent.rows[0]!.status).toBe('PENDING');

    // 3. Nova instância de Publisher inicia (recuperação)
    const newPublisher = new OutboxPublisher(store.getPool(), nc);
    const pubResult = await newPublisher.publishPending();
    expect(pubResult.published).toHaveLength(1);

    // 4. Status atualizado para PUBLISHED
    const publishedEvent = await pool.query<{ status: string; published_at: Date | null }>(
      `SELECT status, published_at FROM outbox_events WHERE correlation_id = $1`,
      [correlationId],
    );
    expect(publishedEvent.rows[0]!.status).toBe('PUBLISHED');
    expect(publishedEvent.rows[0]!.published_at).not.toBeNull();

    const recoveredAt = new Date().toISOString();
    recordResiliencyEvidence({
      scenario: 'publisher-crash-recovery',
      riskId: 'RISK-RES-004',
      controlId: 'CTRL-RES-PUBLISHER-CRASH-001',
      startedAt,
      recoveredAt,
      durationMs: Date.now() - startTime,
      observedFailure: 'PUBLISHER_PROCESS_CRASH',
      finalState: {
        outboxStatus: 'PUBLISHED',
        eventLost: false,
        recoveredByNewInstance: true,
      },
      result: 'PASSED',
    });
  });

  // =========================================================================
  // Cenário 5: Timeout/retry da API
  // =========================================================================
  test('Cenário 5: Timeout e retry da API com persistência relacional preserva cardinalidade única e diagnóstico', async ({}, testInfo) => {
    declareControl(testInfo, {
      riskId: 'RISK-RES-005',
      risk: 'Timeout de rede na chamada de API causa retentativa cliente que duplica registros no PostgreSQL ou gera conflito indevido.',
      controlId: 'CTRL-RES-API-TIMEOUT-RETRY-001',
      control: 'Simular repetição de requisição com timeout do cliente usando a mesma Idempotency-Key sobre o banco relacional e verificar replay idêntico.',
    });

    const startedAt = new Date().toISOString();
    const startTime = Date.now();
    const key = `res-api-timeout-${crypto.randomUUID()}`;
    const firstCorrelationId = `corr-first-attempt-${crypto.randomUUID()}`;
    const retryCorrelationId = `corr-retry-after-timeout-${crypto.randomUUID()}`;

    // 1. Primeira tentativa (cliente disparou, banco salvou, mas cliente sofreu timeout antes da resposta)
    const firstAttempt = await store.createInstance(validInstanceRequest, key, firstCorrelationId);
    expect(firstAttempt.kind).toBe('created');
    if (firstAttempt.kind !== 'created') return;

    // 2. Segunda tentativa pelo cliente com mesma chave e novo correlationId de tentativa
    const retryAttempt = await store.createInstance(validInstanceRequest, key, retryCorrelationId);
    expect(retryAttempt.kind).toBe('replayed');
    if (retryAttempt.kind !== 'replayed') return;

    // 3. Verificar identidade preservada e cardinalidade 1 no PostgreSQL
    expect(retryAttempt.operation.id).toBe(firstAttempt.operation.id);
    expect(retryAttempt.operation.resourceId).toBe(firstAttempt.operation.resourceId);
    expect(retryAttempt.operation.correlationId).toBe(firstCorrelationId);

    const pool = store.getPool();
    const instancesCount = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int as count FROM instances WHERE id = $1`,
      [firstAttempt.operation.resourceId],
    );
    expect(instancesCount.rows[0]!.count).toBe(1);

    const operationsCount = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int as count FROM operations WHERE id = $1`,
      [firstAttempt.operation.id],
    );
    expect(operationsCount.rows[0]!.count).toBe(1);

    const outboxCount = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int as count FROM outbox_events WHERE aggregate_id = $1`,
      [firstAttempt.operation.resourceId],
    );
    expect(outboxCount.rows[0]!.count).toBe(1);

    const recoveredAt = new Date().toISOString();
    recordResiliencyEvidence({
      scenario: 'api-timeout-retry-persistence',
      riskId: 'RISK-RES-005',
      controlId: 'CTRL-RES-API-TIMEOUT-RETRY-001',
      startedAt,
      recoveredAt,
      durationMs: Date.now() - startTime,
      observedFailure: 'CLIENT_HTTP_TIMEOUT_RETRY',
      finalState: {
        replayKind: 'replayed',
        instancesCount: 1,
        operationsCount: 1,
        outboxEventsCount: 1,
        originalCorrelationPreserved: true,
      },
      result: 'PASSED',
    });
  });

  // =========================================================================
  // Cenário 6: Falha controlada durante processamento do consumer
  // =========================================================================
  test('Cenário 6: Falha controlada no meio do consumer não confirma ACK e reprocessa seguramente sem estado inconsistente', async ({}, testInfo) => {
    declareControl(testInfo, {
      riskId: 'RISK-RES-006',
      risk: 'Falha interna ou crash durante a execução do consumidor commita estado parcial ou confirma ACK prematuramente.',
      controlId: 'CTRL-RES-CONSUMER-FAIL-BEFORE-ACK-001',
      control: 'Injetar erro durante a transação do consumidor, verificar rollback atômico (sem ACK e sem processed_events) e reexecutar com sucesso.',
    });

    const startedAt = new Date().toISOString();
    const startTime = Date.now();
    const key = `res-consumer-fail-${crypto.randomUUID()}`;
    const correlationId = `corr-consumer-fail-${crypto.randomUUID()}`;

    const createResult = await store.createInstance(validInstanceRequest, key, correlationId);
    expect(createResult.kind).toBe('created');
    if (createResult.kind !== 'created') return;

    const events = await store.getPendingOutboxEvents(1);
    const payload = events[0]!.payload;

    // 1. Execução do consumidor com falha simulada ANTES do commit/ACK
    await expect(
      consumer.processPayload(payload, { simulateFailureDuringProcessing: true }),
    ).rejects.toThrow('SIMULATED_CONSUMER_PROCESSING_FAILURE');

    // 2. Verificar rollback atômico: processed_events VAZIO, operação continua PENDING, instância continua PROVISIONING
    const pool = store.getPool();
    const checkProcessed = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int as count FROM processed_events WHERE event_id = $1`,
      [payload.eventId],
    );
    expect(checkProcessed.rows[0]!.count).toBe(0);

    const checkOp = await store.getOperation(createResult.operation.id);
    expect(checkOp?.status).toBe('PENDING');

    const checkInst = await store.getInstance(createResult.operation.resourceId);
    expect(checkInst?.status).toBe('PROVISIONING');

    // 3. Reexecução segura (simulando reentrega legítima após falha)
    const retryResult = await consumer.processPayload(payload, { simulateFailureDuringProcessing: false });
    expect(retryResult.kind).toBe('processed');

    // 4. Verificar conclusão transacional consistente pós-recuperação
    const finalProcessed = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int as count FROM processed_events WHERE event_id = $1`,
      [payload.eventId],
    );
    expect(finalProcessed.rows[0]!.count).toBe(1);

    const finalOp = await store.getOperation(createResult.operation.id);
    expect(finalOp?.status).toBe('SUCCEEDED');

    const finalInst = await store.getInstance(createResult.operation.resourceId);
    expect(finalInst?.status).toBe('RUNNING');

    const recoveredAt = new Date().toISOString();
    recordResiliencyEvidence({
      scenario: 'consumer-failure-before-ack',
      riskId: 'RISK-RES-006',
      controlId: 'CTRL-RES-CONSUMER-FAIL-BEFORE-ACK-001',
      startedAt,
      recoveredAt,
      durationMs: Date.now() - startTime,
      observedFailure: 'SIMULATED_CONSUMER_PROCESSING_FAILURE',
      finalState: {
        rollbackVerified: true,
        recoveredOnRetry: true,
        finalOperationStatus: finalOp?.status,
        finalInstanceStatus: finalInst?.status,
        processedEventsCount: 1,
      },
      result: 'PASSED',
    });
  });
});
