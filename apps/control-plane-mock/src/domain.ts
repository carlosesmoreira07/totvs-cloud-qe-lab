export type InstanceStatus = 'PROVISIONING' | 'RUNNING' | 'ERROR';
export type OperationStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED';

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

