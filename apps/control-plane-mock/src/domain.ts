export type InstanceStatus = 'PROVISIONING' | 'RUNNING' | 'ERROR';
export type OperationStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED';
export type OutboxEventStatus = 'PENDING' | 'PUBLISHED' | 'FAILED';

export interface CreateInstanceRequest {
  name: string;
  region: string;
  image: string;
  flavor: string;
}

export interface Instance extends CreateInstanceRequest {
  id: string;
  status: InstanceStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Operation {
  id: string;
  type: 'PROVISION_INSTANCE';
  status: OperationStatus;
  resourceId: string;
  submittedAt: string;
  updatedAt: string;
  correlationId: string;
}

export interface ApiError {
  code: string;
  message: string;
  correlationId: string;
  requestId: string;
  details?: Array<{ field: string; issue: string }>;
}

export interface InstanceProvisioningRequestedPayload {
  eventId: string;
  instanceId: string;
  operationId: string;
  correlationId: string;
  occurredAt: string;
  traceparent?: string;
}

export interface OutboxEvent {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  correlationId: string;
  payload: InstanceProvisioningRequestedPayload;
  status: OutboxEventStatus;
  retryCount: number;
  lastError?: string | null;
  createdAt: string;
  publishedAt?: string | null;
}

export type CreateResult =
  | { kind: 'created'; operation: Operation }
  | { kind: 'replayed'; operation: Operation }
  | { kind: 'conflict' };

export interface ControlPlaneStoreInterface {
  createInstance(
    payload: CreateInstanceRequest,
    idempotencyKey: string,
    correlationId: string,
    traceparent?: string,
  ): Promise<CreateResult> | CreateResult;
  getOperation(id: string): Promise<Operation | undefined> | Operation | undefined;
  getInstance(id: string): Promise<Instance | undefined> | Instance | undefined;
}
