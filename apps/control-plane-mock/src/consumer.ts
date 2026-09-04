import type pg from 'pg';
import {
  consumerOpts,
  createInbox,
  type JetStreamSubscription,
  type NatsConnection,
} from 'nats';
import { sc } from './nats-jetstream.js';
import type { InstanceProvisioningRequestedPayload } from './domain.js';

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
}

export class EventConsumer {
  private readonly pool: pg.Pool;
  private readonly nc: NatsConnection;
  private subscription?: JetStreamSubscription | undefined;
  private isRunning = false;

  constructor(pool: pg.Pool, nc: NatsConnection) {
    this.pool = pool;
    this.nc = nc;
  }

  async processPayload(
    payload: InstanceProvisioningRequestedPayload,
    _options?: ProcessOptions,
  ): Promise<ConsumerProcessResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const existingCheck = await client.query<{ event_id: string }>(
        `SELECT event_id FROM processed_events WHERE event_id = $1 FOR UPDATE`,
        [payload.eventId],
      );

      if (existingCheck.rows.length > 0) {
        await client.query('COMMIT');
        return {
          kind: 'already_processed',
          eventId: payload.eventId,
          instanceId: payload.instanceId,
          operationId: payload.operationId,
        };
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

      await client.query(
        `INSERT INTO processed_events (event_id, consumer_name, processed_at)
         VALUES ($1, 'instance-provisioning-consumer', NOW())`,
        [payload.eventId],
      );

      await client.query('COMMIT');

      return {
        kind: 'processed',
        eventId: payload.eventId,
        instanceId: payload.instanceId,
        operationId: payload.operationId,
      };
    } catch (error) {
      await client.query('ROLLBACK');
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
            msg.ack();
          } catch (error) {
            console.error('[LAB EventConsumer] error processing message:', error);
            // In case of transient processing error, do not ack so it can be redelivered
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
