import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { trace } from '@opentelemetry/api';
import type {
  ControlPlaneStoreInterface,
  CreateInstanceRequest,
  CreateResult,
  Instance,
  InstanceProvisioningRequestedPayload,
  Operation,
  OutboxEvent,
} from './domain.js';
import {
  getTracer,
  extractContextFromTraceparent,
  createTraceparent,
  recordOutboxPending,
  SpanKind,
  SpanStatusCode,
} from './telemetry.js';

const { Pool } = pg;

export interface PostgresStoreConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
}

export class PostgresControlPlaneStore implements ControlPlaneStoreInterface {
  private readonly pool: pg.Pool;

  constructor(poolOrConfig?: pg.Pool | PostgresStoreConfig) {
    if (poolOrConfig instanceof Pool) {
      this.pool = poolOrConfig;
    } else {
      const config = poolOrConfig ?? {};
      this.pool = new Pool({
        connectionString: config.connectionString ?? process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/control_plane',
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
      });
    }
  }

  getPool(): pg.Pool {
    return this.pool;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS instances (
        id UUID PRIMARY KEY,
        name VARCHAR(40) NOT NULL,
        region VARCHAR(64) NOT NULL,
        image VARCHAR(128) NOT NULL,
        flavor VARCHAR(64) NOT NULL,
        status VARCHAR(32) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS operations (
        id UUID PRIMARY KEY,
        type VARCHAR(64) NOT NULL,
        status VARCHAR(32) NOT NULL,
        resource_id UUID NOT NULL REFERENCES instances(id),
        correlation_id VARCHAR(128) NOT NULL,
        submitted_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS idempotency_records (
        idempotency_key VARCHAR(128) PRIMARY KEY,
        fingerprint VARCHAR(64) NOT NULL,
        operation_id UUID NOT NULL REFERENCES operations(id),
        created_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS outbox_events (
        id UUID PRIMARY KEY,
        event_type VARCHAR(128) NOT NULL,
        aggregate_type VARCHAR(64) NOT NULL,
        aggregate_id UUID NOT NULL,
        correlation_id VARCHAR(128) NOT NULL,
        payload JSONB NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
        retry_count INT NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        published_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_outbox_events_pending 
      ON outbox_events (status, created_at) 
      WHERE status = 'PENDING';

      CREATE TABLE IF NOT EXISTS processed_events (
        event_id UUID PRIMARY KEY,
        consumer_name VARCHAR(64) NOT NULL,
        processed_at TIMESTAMPTZ NOT NULL
      );
    `);
  }

  async clearTables(): Promise<void> {
    await this.pool.query(`
      TRUNCATE idempotency_records, operations, instances, outbox_events, processed_events CASCADE;
    `);
  }

  async createInstance(
    payload: CreateInstanceRequest,
    idempotencyKey: string,
    correlationId: string,
    traceparent?: string,
  ): Promise<CreateResult> {
    const parentContext = extractContextFromTraceparent(traceparent);
    const tracer = getTracer();

    const txSpan = tracer.startSpan(
      'db.transaction.create_instance',
      {
        kind: SpanKind.CLIENT,
        attributes: {
          'db.system': 'postgresql',
          'db.operation': 'create_instance',
          correlation_id: correlationId,
          idempotency_key: idempotencyKey,
        },
      },
      parentContext,
    );
    const txContext = trace.setSpan(parentContext, txSpan);

    const fingerprint = createHash('sha256')
      .update(JSON.stringify({
        name: payload.name,
        region: payload.region,
        image: payload.image,
        flavor: payload.flavor,
      }))
      .digest('hex');

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const existingCheck = await client.query<{
        fingerprint: string;
        operation_id: string;
      }>(
        `SELECT fingerprint, operation_id FROM idempotency_records WHERE idempotency_key = $1 FOR UPDATE`,
        [idempotencyKey],
      );

      if (existingCheck.rows.length > 0) {
        const existing = existingCheck.rows[0]!;
        if (existing.fingerprint !== fingerprint) {
          await client.query('ROLLBACK');
          txSpan.setStatus({ code: SpanStatusCode.ERROR, message: 'IDEMPOTENCY_CONFLICT' });
          txSpan.end();
          return { kind: 'conflict' };
        }

        const opResult = await client.query<{
          id: string;
          type: 'PROVISION_INSTANCE';
          status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
          resource_id: string;
          submitted_at: Date;
          updated_at: Date;
          correlation_id: string;
        }>(
          `SELECT id, type, status, resource_id, correlation_id, submitted_at, updated_at 
           FROM operations WHERE id = $1`,
          [existing.operation_id],
        );

        await client.query('COMMIT');
        txSpan.setStatus({ code: SpanStatusCode.OK });
        txSpan.end();

        const op = opResult.rows[0]!;
        return {
          kind: 'replayed',
          operation: {
            id: op.id,
            type: op.type,
            status: op.status,
            resourceId: op.resource_id,
            submittedAt: op.submitted_at.toISOString(),
            updatedAt: op.updated_at.toISOString(),
            correlationId: op.correlation_id,
          },
        };
      }

      const now = new Date();
      const nowIso = now.toISOString();
      const instanceId = randomUUID();
      const operationId = randomUUID();
      const outboxEventId = randomUUID();

      await client.query(
        `INSERT INTO instances (id, name, region, image, flavor, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'PROVISIONING', $6, $6)`,
        [instanceId, payload.name, payload.region, payload.image, payload.flavor, nowIso],
      );

      await client.query(
        `INSERT INTO operations (id, type, status, resource_id, correlation_id, submitted_at, updated_at)
         VALUES ($1, 'PROVISION_INSTANCE', 'PENDING', $2, $3, $4, $4)`,
        [operationId, instanceId, correlationId, nowIso],
      );

      await client.query(
        `INSERT INTO idempotency_records (idempotency_key, fingerprint, operation_id, created_at)
         VALUES ($1, $2, $3, $4)`,
        [idempotencyKey, fingerprint, operationId, nowIso],
      );

      // Instrumenta a criacao do evento no outbox como span filho da transacao
      const outboxSpan = tracer.startSpan(
        'outbox.create_event',
        {
          kind: SpanKind.PRODUCER,
          attributes: {
            'event.type': 'instance.provisioning.requested',
            'event.id': outboxEventId,
            correlation_id: correlationId,
          },
        },
        txContext,
      );
      const outboxSpanContext = outboxSpan.spanContext();
      const outboxTraceparent = createTraceparent(outboxSpanContext.traceId, outboxSpanContext.spanId);

      const eventPayload: InstanceProvisioningRequestedPayload = {
        eventId: outboxEventId,
        instanceId,
        operationId,
        correlationId,
        occurredAt: nowIso,
        traceparent: outboxTraceparent,
      };

      await client.query(
        `INSERT INTO outbox_events (
           id, event_type, aggregate_type, aggregate_id, correlation_id, payload, status, retry_count, created_at
         ) VALUES ($1, 'instance.provisioning.requested', 'instance', $2, $3, $4, 'PENDING', 0, $5)`,
        [outboxEventId, instanceId, correlationId, JSON.stringify(eventPayload), nowIso],
      );

      outboxSpan.setStatus({ code: SpanStatusCode.OK });
      outboxSpan.end();
      recordOutboxPending(1);

      await client.query('COMMIT');
      txSpan.setStatus({ code: SpanStatusCode.OK });
      txSpan.end();

      const operation: Operation = {
        id: operationId,
        type: 'PROVISION_INSTANCE',
        status: 'PENDING',
        resourceId: instanceId,
        submittedAt: nowIso,
        updatedAt: nowIso,
        correlationId,
      };

      return { kind: 'created', operation };
    } catch (error) {
      await client.query('ROLLBACK');
      txSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      txSpan.end();
      throw error;
    } finally {
      client.release();
    }
  }

  async getOperation(id: string): Promise<Operation | undefined> {
    const result = await this.pool.query<{
      id: string;
      type: 'PROVISION_INSTANCE';
      status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
      resource_id: string;
      submitted_at: Date;
      updated_at: Date;
      correlation_id: string;
    }>(
      `SELECT id, type, status, resource_id, correlation_id, submitted_at, updated_at 
       FROM operations WHERE id = $1`,
      [id],
    );

    if (result.rows.length === 0) return undefined;
    const row = result.rows[0]!;
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      resourceId: row.resource_id,
      submittedAt: row.submitted_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      correlationId: row.correlation_id,
    };
  }

  async getInstance(id: string): Promise<Instance | undefined> {
    const result = await this.pool.query<{
      id: string;
      name: string;
      region: string;
      image: string;
      flavor: string;
      status: 'PROVISIONING' | 'RUNNING' | 'ERROR';
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, name, region, image, flavor, status, created_at, updated_at 
       FROM instances WHERE id = $1`,
      [id],
    );

    if (result.rows.length === 0) return undefined;
    const row = result.rows[0]!;
    return {
      id: row.id,
      name: row.name,
      region: row.region,
      image: row.image,
      flavor: row.flavor,
      status: row.status,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async getOutboxEvent(id: string): Promise<OutboxEvent | undefined> {
    const result = await this.pool.query<{
      id: string;
      event_type: string;
      aggregate_type: string;
      aggregate_id: string;
      correlation_id: string;
      payload: InstanceProvisioningRequestedPayload;
      status: 'PENDING' | 'PUBLISHED' | 'FAILED';
      retry_count: number;
      last_error: string | null;
      created_at: Date;
      published_at: Date | null;
    }>(
      `SELECT id, event_type, aggregate_type, aggregate_id, correlation_id, payload, status, retry_count, last_error, created_at, published_at 
       FROM outbox_events WHERE id = $1`,
      [id],
    );

    if (result.rows.length === 0) return undefined;
    const row = result.rows[0]!;
    return {
      id: row.id,
      eventType: row.event_type,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      correlationId: row.correlation_id,
      payload: row.payload,
      status: row.status,
      retryCount: row.retry_count,
      lastError: row.last_error,
      createdAt: row.created_at.toISOString(),
      publishedAt: row.published_at ? row.published_at.toISOString() : null,
    };
  }

  async getPendingOutboxEvents(limit = 10): Promise<OutboxEvent[]> {
    const result = await this.pool.query<{
      id: string;
      event_type: string;
      aggregate_type: string;
      aggregate_id: string;
      correlation_id: string;
      payload: InstanceProvisioningRequestedPayload;
      status: 'PENDING' | 'PUBLISHED' | 'FAILED';
      retry_count: number;
      last_error: string | null;
      created_at: Date;
      published_at: Date | null;
    }>(
      `SELECT id, event_type, aggregate_type, aggregate_id, correlation_id, payload, status, retry_count, last_error, created_at, published_at 
       FROM outbox_events 
       WHERE status = 'PENDING' 
       ORDER BY created_at ASC 
       LIMIT $1`,
      [limit],
    );

    return result.rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      correlationId: row.correlation_id,
      payload: row.payload,
      status: row.status,
      retryCount: row.retry_count,
      lastError: row.last_error,
      createdAt: row.created_at.toISOString(),
      publishedAt: row.published_at ? row.published_at.toISOString() : null,
    }));
  }
}
