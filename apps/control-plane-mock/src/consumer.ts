import type pg from 'pg';
import {
  consumerOpts,
  createInbox,
  type JetStreamSubscription,
  type NatsConnection,
} from 'nats';
import { trace } from '@opentelemetry/api';
import { sc } from './nats-jetstream.js';
import type { InstanceProvisioningRequestedPayload } from './domain.js';
import {
  getTracer,
  extractContextFromTraceparent,
  recordMessageProcessed,
  recordMessageRedelivery,
  recordConsumerFailure,
  SpanKind,
  SpanStatusCode,
} from './telemetry.js';

export type ConsumerProcessResult =
  | {
      kind: 'processed';
      eventId: string;
      instanceId: string;
      operationId: string;
    }
  | {
      kind: 'already_processed';
      eventId: string;
      instanceId: string;
      operationId: string;
    };

export interface ProcessOptions {
  simulateDuplicate?: boolean;
  simulateFailureDuringProcessing?: boolean;
}

export class EventConsumer {
  private readonly pool: pg.Pool;
  private readonly nc: NatsConnection;
  private subscription?: JetStreamSubscription | undefined;
  private isRunning = false;
  private simulateFailure = false;

  constructor(pool: pg.Pool, nc: NatsConnection) {
    this.pool = pool;
    this.nc = nc;
  }

  setSimulateFailure(simulate: boolean): void {
    this.simulateFailure = simulate;
  }

  async processPayload(
    payload: InstanceProvisioningRequestedPayload,
    options?: ProcessOptions,
  ): Promise<ConsumerProcessResult> {
    const shouldFail = options?.simulateFailureDuringProcessing ?? this.simulateFailure;
    const parentContext = extractContextFromTraceparent(payload.traceparent);
    const tracer = getTracer();

    const consumeSpan = tracer.startSpan(
      'nats.consume',
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          'messaging.system': 'nats',
          'messaging.operation': 'process',
          'event.id': payload.eventId,
          correlation_id: payload.correlationId,
        },
      },
      parentContext,
    );
    const consumeContext = trace.setSpan(parentContext, consumeSpan);

    const client = await this.pool.connect();
    const dbSpan = tracer.startSpan(
      'db.transaction.update_state',
      {
        kind: SpanKind.CLIENT,
        attributes: {
          'db.system': 'postgresql',
          'db.operation': 'update_state',
          'event.id': payload.eventId,
          instance_id: payload.instanceId,
          operation_id: payload.operationId,
        },
      },
      consumeContext,
    );

    try {
      await client.query('BEGIN');

      // [LAB] Deduplicação atômica via PK: INSERT ON CONFLICT DO NOTHING
      // Previne race condition se dois consumers tentarem processar concorrentemente
      // um evento ainda não registrado.
      const insertResult = await client.query<{ event_id: string }>(
        `INSERT INTO processed_events (event_id, consumer_name, processed_at)
         VALUES ($1, 'instance-provisioning-consumer', NOW())
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
        [payload.eventId],
      );

      if (insertResult.rows.length === 0) {
        await client.query('COMMIT');
        dbSpan.setStatus({ code: SpanStatusCode.OK });
        dbSpan.end();
        consumeSpan.setStatus({ code: SpanStatusCode.OK });
        consumeSpan.end();
        recordMessageRedelivery('instance.provisioning.requested');
        recordMessageProcessed('instance.provisioning.requested', 'already_processed');
        return {
          kind: 'already_processed',
          eventId: payload.eventId,
          instanceId: payload.instanceId,
          operationId: payload.operationId,
        };
      }

      if (shouldFail) {
        throw new Error('SIMULATED_CONSUMER_PROCESSING_FAILURE');
      }

      await client.query(
        `UPDATE operations
         SET status = 'SUCCEEDED',
             updated_at = NOW()
         WHERE id = $1 AND status = 'PENDING'`,
        [payload.operationId],
      );

      await client.query(
        `UPDATE instances
         SET status = 'RUNNING',
             updated_at = NOW()
         WHERE id = $1 AND status = 'PROVISIONING'`,
        [payload.instanceId],
      );

      await client.query('COMMIT');
      dbSpan.setStatus({ code: SpanStatusCode.OK });
      dbSpan.end();
      consumeSpan.setStatus({ code: SpanStatusCode.OK });
      consumeSpan.end();
      recordMessageProcessed('instance.provisioning.requested', 'processed');

      return {
        kind: 'processed',
        eventId: payload.eventId,
        instanceId: payload.instanceId,
        operationId: payload.operationId,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      const errorMessage = error instanceof Error ? error.message : String(error);
      dbSpan.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });
      dbSpan.end();
      consumeSpan.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });
      consumeSpan.end();
      recordConsumerFailure(errorMessage);
      throw error;
    } finally {
      client.release();
    }
  }

  async start(subject = 'instance.provisioning.requested'): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    const js = this.nc.jetstream();
    const opts = consumerOpts();
    opts.durable('instance-provisioning-consumer');
    opts.manualAck();
    opts.ackExplicit();
    opts.deliverTo(createInbox());

    this.subscription = await js.subscribe(subject, opts);

    (async () => {
      try {
        for await (const msg of this.subscription!) {
          if (!this.isRunning) break;
          try {
            const rawData = sc.decode(msg.data);
            const payload = JSON.parse(rawData) as InstanceProvisioningRequestedPayload;
            await this.processPayload(payload);
            // [LAB] Confirma ACK somente após conclusão transacional bem-sucedida
            msg.ack();
          } catch (error) {
            console.error('[LAB EventConsumer] error processing message, not acking:', error);
            // [LAB] Em caso de erro, não confirma ACK para permitir reentrega segura
          }
        }
      } catch (error) {
        if (this.isRunning) {
          console.error('[LAB EventConsumer] subscription stream error:', error);
        }
      }
    })();
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.subscription) {
      try {
        await this.subscription.drain();
      } catch {
        // ignore errors during shutdown
      }
      this.subscription = undefined;
    }
  }
}
