import { expect, test, type APIResponse } from '@playwright/test';
import {
  declareControl,
  expectJsonError,
  validInstanceRequest,
  waitForOperation,
} from '../helpers/quality.js';

interface OperationBody {
  id: string;
  resourceId: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  submittedAt: string;
  correlationId: string;
}

async function operationFrom(response: APIResponse): Promise<OperationBody> {
  expect(response.status()).toBe(202);
  return response.json() as Promise<OperationBody>;
}

test('retry sequencial reutiliza operação e instância com diagnóstico por tentativa', async ({
  request,
}, testInfo) => {
  declareControl(testInfo, {
    riskId: 'RISK-API-005',
    risk: 'Uma repetição legítima pode retornar outra identidade ou perder o diagnóstico da tentativa.',
    controlId: 'CTRL-IDEMPOTENCY-001',
    control: 'Repetir chave e payload, comparar IDs e verificar correlation/request IDs por tentativa.',
  });

  const key = `sequential-${crypto.randomUUID()}`;
  const firstCorrelationId = `first-${crypto.randomUUID()}`;
  const retryCorrelationId = `retry-${crypto.randomUUID()}`;
  const first = await request.post('/v1/instances', {
    headers: {
      'Idempotency-Key': key,
      'X-Correlation-Id': firstCorrelationId,
    },
    data: validInstanceRequest,
  });
  const retry = await request.post('/v1/instances', {
    headers: {
      'Idempotency-Key': key,
      'X-Correlation-Id': retryCorrelationId,
    },
    data: validInstanceRequest,
  });

  const [firstOperation, retriedOperation] = await Promise.all([
    operationFrom(first),
    operationFrom(retry),
  ]);
  expect(first.headers()['idempotency-replayed']).toBe('false');
  expect(retry.headers()['idempotency-replayed']).toBe('true');
  expect(retry.headers().location).toBe(first.headers().location);
  expect(retriedOperation).toMatchObject({
    id: firstOperation.id,
    resourceId: firstOperation.resourceId,
    submittedAt: firstOperation.submittedAt,
    correlationId: firstCorrelationId,
  });
  expect(first.headers()['x-correlation-id']).toBe(firstCorrelationId);
  expect(retry.headers()['x-correlation-id']).toBe(retryCorrelationId);
  expect(retry.headers()['x-request-id']).not.toBe(first.headers()['x-request-id']);
});

test('retry depois da conclusão retorna a operação atual sem novo provisionamento', async ({
  request,
}, testInfo) => {
  declareControl(testInfo, {
    riskId: 'RISK-API-007',
    risk: 'Retry após a conclusão pode reiniciar a operação ou apontar para outro recurso.',
    controlId: 'CTRL-ASYNC-001',
    control: 'Concluir por polling, repetir a criação e verificar identidade e estado final preservados.',
  });

  const key = `completed-${crypto.randomUUID()}`;
  const originalCorrelationId = `original-${crypto.randomUUID()}`;
  const first = await request.post('/v1/instances', {
    headers: {
      'Idempotency-Key': key,
      'X-Correlation-Id': originalCorrelationId,
    },
    data: validInstanceRequest,
  });
  const firstOperation = await operationFrom(first);
  await waitForOperation(request, firstOperation.id);

  const retryCorrelationId = `completed-retry-${crypto.randomUUID()}`;
  const retry = await request.post('/v1/instances', {
    headers: {
      'Idempotency-Key': key,
      'X-Correlation-Id': retryCorrelationId,
    },
    data: validInstanceRequest,
  });
  const retriedOperation = await operationFrom(retry);

  expect(retry.headers()['idempotency-replayed']).toBe('true');
  expect(retry.headers()['x-correlation-id']).toBe(retryCorrelationId);
  expect(retriedOperation).toMatchObject({
    id: firstOperation.id,
    resourceId: firstOperation.resourceId,
    status: 'SUCCEEDED',
    correlationId: originalCorrelationId,
  });

  const instance = await request.get(`/v1/instances/${firstOperation.resourceId}`);
  expect(instance.status()).toBe(200);
  await expect(instance.json()).resolves.toMatchObject({
    id: firstOperation.resourceId,
    status: 'RUNNING',
  });
});

test('mesma chave com payload diferente retorna conflito e preserva a criação original', async ({
  request,
}, testInfo) => {
  declareControl(testInfo, {
    riskId: 'RISK-API-005',
    risk: 'Reutilizar uma chave para outra intenção pode sobrescrever ou duplicar o provisionamento original.',
    controlId: 'CTRL-IDEMPOTENCY-001',
    control: 'Exigir 409 para payload diferente e confirmar que o payload original ainda reutiliza os mesmos IDs.',
  });

  const key = `conflict-${crypto.randomUUID()}`;
  const original = await request.post('/v1/instances', {
    headers: { 'Idempotency-Key': key },
    data: validInstanceRequest,
  });
  const originalOperation = await operationFrom(original);
  const conflictCorrelationId = `conflict-${crypto.randomUUID()}`;
  const conflict = await request.post('/v1/instances', {
    headers: {
      'Idempotency-Key': key,
      'X-Correlation-Id': conflictCorrelationId,
    },
    data: { ...validInstanceRequest, flavor: 'lab-medium' },
  });

  await expectJsonError(conflict, 409, 'IDEMPOTENCY_CONFLICT');
  expect(conflict.headers()['x-correlation-id']).toBe(conflictCorrelationId);
  await expect(conflict.json()).resolves.toMatchObject({ correlationId: conflictCorrelationId });

  const replay = await request.post('/v1/instances', {
    headers: { 'Idempotency-Key': key },
    data: validInstanceRequest,
  });
  const replayedOperation = await operationFrom(replay);
  expect(replay.headers()['idempotency-replayed']).toBe('true');
  expect(replayedOperation.id).toBe(originalOperation.id);
  expect(replayedOperation.resourceId).toBe(originalOperation.resourceId);
});

test('requisições concorrentes criam um único par de operação e instância', async ({
  request,
}, testInfo) => {
  declareControl(testInfo, {
    riskId: 'RISK-API-006',
    risk: 'Concorrência com a mesma chave pode criar operações ou instâncias duplicadas.',
    controlId: 'CTRL-DUPLICATE-001',
    control: 'Disparar tentativas concorrentes e exigir uma criação, replays e cardinalidade única dos IDs.',
  });

  const key = `concurrent-${crypto.randomUUID()}`;
  const correlationIds = Array.from(
    { length: 8 },
    (_, index) => `concurrent-${index}-${crypto.randomUUID()}`,
  );
  const responses = await Promise.all(
    correlationIds.map((correlationId) => request.post('/v1/instances', {
      headers: {
        'Idempotency-Key': key,
        'X-Correlation-Id': correlationId,
      },
      data: validInstanceRequest,
    })),
  );
  const operations = await Promise.all(responses.map(operationFrom));

  expect(
    responses.filter((response) => response.headers()['idempotency-replayed'] === 'false'),
  ).toHaveLength(1);
  expect(
    responses.filter((response) => response.headers()['idempotency-replayed'] === 'true'),
  ).toHaveLength(7);
  expect(new Set(operations.map((operation) => operation.id)).size).toBe(1);
  expect(new Set(operations.map((operation) => operation.resourceId)).size).toBe(1);
  expect(new Set(responses.map((response) => response.headers().location)).size).toBe(1);
  expect(new Set(responses.map((response) => response.headers()['x-request-id'])).size).toBe(8);

  responses.forEach((response, index) => {
    expect(response.headers()['x-correlation-id']).toBe(correlationIds[index]);
  });
  const operationCorrelationIds = new Set(operations.map((operation) => operation.correlationId));
  expect(operationCorrelationIds.size).toBe(1);
  expect(correlationIds).toContain([...operationCorrelationIds][0]);
});
