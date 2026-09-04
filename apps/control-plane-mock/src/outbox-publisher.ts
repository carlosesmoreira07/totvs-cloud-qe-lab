import type pg from 'pg';
import type { NatsConnection } from 'nats';
import { sc } from './nats-jetstream.js';
import type { InstanceProvisioningRequestedPayload } from './domain.js';

export interface PublishResult {
  published: string[];
  failed: string[];
  total: number;
}

export interface PublishOptions {
  simulatePublishFailure?: boolean;
  limit?: number;
}

export interface OutboxPublisherOptions {
  pollIntervalMs?: number;
  batchSize?: number;
}

export class OutboxPublisher {
  private readonly pool: pg.Pool;
  private readonly nc: NatsConnection;
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private simulatePublishFailure = false;
  private timer?: NodeJS.Timeout | undefined;
  private isProcessing = false;

  constructor(
    pool: pg.Pool,
    nc: NatsConnection,
    options?: OutboxPublisherOptions,
  ) {
    this.pool = pool;
    this.nc = nc;
    this.batchSize = options?.batchSize ?? 10;
    this.pollIntervalMs = options?.pollIntervalMs ?? 100;
  }

  setSimulatePublishFailure(simulate: boolean): void {
    this.simulatePublishFailure = simulate;
  }

  getSimulatePublishFailure(): boolean {
    return this.simulatePublishFailure;
  }

  async publishPending(options?: PublishOptions): Promise<PublishResult> {
    const simulateFailure = options?.simulatePublishFailure ?? this.simulatePublishFailure;
    const limit = options?.limit ?? this.batchSize;
    const published: string[] = [];
    const failed: string[] = [];

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query<{
        id: string;
        event_type: string;
        aggregate_type: string;
        aggregate_id: string;
        correlation_id: string;
        payload: InstanceProvisioningRequestedPayload;
        retry_count: number;
      }>(
        `SELECT id, event_type, aggregate_type, aggregate_id, correlation_id, payload, retry_count
         FROM outbox_events
         WHERE status = 'PENDING'
         ORDER BY created_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [limit],
      );

      if (result.rows.length === 0) {
        await client.query('COMMIT');
        return { published, failed, total: 0 };
      }

      const js = this.nc.jetstream();

      for (const event of result.rows) {
        if (simulateFailure) {
          await client.query(
            `UPDATE outbox_events
             SET retry_count = retry_count + 1,
                 last_error = 'SIMULATED_PUBLISH_FAILURE'
             WHERE id = $1`,
            [event.id],
          );
          failed.push(event.id);
          continue;
        }

        try {
          const subject = event.event_type;
          const payloadData = typeof event.payload === 'string'
            ? event.payload
            : JSON.stringify(event.payload);

          // [LAB] JetStream deduplication via msgId
          await js.publish(subject, sc.encode(payloadData), {
            msgID: event.id,
          });

          await client.query(
            `UPDATE outbox_events
             SET status = 'PUBLISHED',
                 published_at = NOW(),
                 last_error = NULL
             WHERE id = $1`,
            [event.id],
          );
          published.push(event.id);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          await client.query(
            `UPDATE outbox_events
             SET retry_count = retry_count + 1,
                 last_error = $1
             WHERE id = $2`,
            [errorMessage, event.id],
          );
          failed.push(event.id);
        }
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    return {
      published,
      failed,
      total: published.length + failed.length,
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(async () => {
      if (this.isProcessing) return;
      this.isProcessing = true;
      try {
        await this.publishPending();
      } catch (error) {
        // [LAB] Publisher logs error without crashing worker loop
        console.error('[LAB OutboxPublisher] error publishing pending events:', error);
      } finally {
        this.isProcessing = false;
      }
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
