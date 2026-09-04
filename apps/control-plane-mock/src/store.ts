import { createHash, randomUUID } from 'node:crypto';
import type { CreateInstanceRequest, Instance, Operation } from './domain.js';

interface IdempotencyRecord {
  fingerprint: string;
  operationId: string;
}

interface StoredOperation {
  operation: Operation;
  completeAt: number;
}

export type CreateResult =
  | { kind: 'created'; operation: Operation }
  | { kind: 'replayed'; operation: Operation }
  | { kind: 'conflict' };

export class ControlPlaneStore {
  private readonly instances = new Map<string, Instance>();
  private readonly operations = new Map<string, StoredOperation>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();

  constructor(private readonly provisioningDelayMs = 75) {}

  createInstance(
    payload: CreateInstanceRequest,
    idempotencyKey: string,
    correlationId: string,
  ): CreateResult {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({
        name: payload.name,
        region: payload.region,
        image: payload.image,
        flavor: payload.flavor,
      }))
      .digest('hex');
    const existing = this.idempotency.get(idempotencyKey);

    if (existing) {
      if (existing.fingerprint !== fingerprint) return { kind: 'conflict' };
      return {
        kind: 'replayed',
        operation: this.getOperation(existing.operationId)!,
      };
    }

    const now = new Date().toISOString();
    const instance: Instance = {
      id: randomUUID(),
      ...payload,
      status: 'PROVISIONING',
      createdAt: now,
      updatedAt: now,
    };
    const operation: Operation = {
      id: randomUUID(),
      type: 'PROVISION_INSTANCE',
      status: 'PENDING',
      resourceId: instance.id,
      submittedAt: now,
      updatedAt: now,
      correlationId,
    };

    // [LAB] This synchronous section is the atomic boundary for the in-memory mock.
    // Node executes it without interleaving another request handler.
    this.instances.set(instance.id, instance);
    this.operations.set(operation.id, {
      operation,
      completeAt: Date.now() + this.provisioningDelayMs,
    });
    this.idempotency.set(idempotencyKey, {
      fingerprint,
      operationId: operation.id,
    });

    return { kind: 'created', operation: { ...operation } };
  }

  getOperation(id: string): Operation | undefined {
    this.refresh(id);
    const stored = this.operations.get(id);
    return stored ? { ...stored.operation } : undefined;
  }

  getInstance(id: string): Instance | undefined {
    for (const operationId of this.operations.keys()) this.refresh(operationId);
    const instance = this.instances.get(id);
    return instance ? { ...instance } : undefined;
  }

  private refresh(operationId: string): void {
    const stored = this.operations.get(operationId);
    if (!stored || stored.operation.status !== 'PENDING' || Date.now() < stored.completeAt) return;

    const completedAt = new Date().toISOString();
    stored.operation.status = 'SUCCEEDED';
    stored.operation.updatedAt = completedAt;
    const instance = this.instances.get(stored.operation.resourceId);
    if (instance) {
      instance.status = 'RUNNING';
      instance.updatedAt = completedAt;
    }
  }
}
