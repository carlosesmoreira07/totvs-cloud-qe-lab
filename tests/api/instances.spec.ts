import { expect, test } from '@playwright/test';
import { declareControl, expectJsonError, validInstanceRequest } from '../helpers/quality.js';

test('cria uma instância válida e conclui a operação assíncrona', async ({ request }, testInfo) => {
  declareControl(
    testInfo,
    'Uma solicitação válida pode ser aceita sem produzir um recurso consultável.',
    'Criar, acompanhar a operação até SUCCEEDED e consultar a instância RUNNING.',
  );

  const createResponse = await request.post('/v1/instances', {
    headers: { 'Idempotency-Key': `create-${crypto.randomUUID()}` },
    data: validInstanceRequest,
  });

  expect(createResponse.status()).toBe(202);
  const operation = await createResponse.json();
  expect(createResponse.headers().location).toBe(`/v1/operations/${operation.id}`);
  expect(operation).toMatchObject({
    type: 'PROVISION_INSTANCE',
    resourceId: expect.any(String),
    correlationId: expect.any(String),
  });

  await expect
    .poll(async () => {
      const response = await request.get(`/v1/operations/${operation.id}`);
      return (await response.json()).status;
    })
    .toBe('SUCCEEDED');

  const instanceResponse = await request.get(`/v1/instances/${operation.resourceId}`);
  expect(instanceResponse.status()).toBe(200);
  await expect(instanceResponse.json()).resolves.toMatchObject({
    ...validInstanceRequest,
    id: operation.resourceId,
    status: 'RUNNING',
  });
});

test('rejeita payload inválido com erro diagnosticável', async ({ request }, testInfo) => {
  declareControl(
    testInfo,
    'Dados incompletos podem iniciar provisionamento ambíguo ou inconsistente.',
    'Rejeitar o payload antes de criar a operação e listar os campos inválidos.',
  );

  const response = await request.post('/v1/instances', {
    headers: { 'Idempotency-Key': `invalid-${crypto.randomUUID()}` },
    data: { name: 'INVALID NAME' },
  });

  await expectJsonError(response, 400, 'INVALID_REQUEST');
  const error = await response.json();
  expect(error.details.map((detail: { field: string }) => detail.field)).toEqual(
    expect.arrayContaining(['name', 'region', 'image', 'flavor']),
  );
});

test('retorna erro consistente para recurso inexistente', async ({ request }, testInfo) => {
  declareControl(
    testInfo,
    'Ausência de recurso pode ser confundida com indisponibilidade ou resposta vazia.',
    'Responder 404 com Error estruturado e IDs de diagnóstico.',
  );

  const response = await request.get(`/v1/instances/${crypto.randomUUID()}`);
  await expectJsonError(response, 404, 'INSTANCE_NOT_FOUND');
  await expect(response.json()).resolves.toMatchObject({ message: 'Instance was not found' });
});

test('preserva correlation ID e gera request ID único', async ({ request }, testInfo) => {
  declareControl(
    testInfo,
    'Falhas distribuídas podem ficar sem rastreabilidade entre chamadas.',
    'Ecoar X-Correlation-Id e gerar um X-Request-Id por requisição.',
  );

  const correlationId = `journey-${crypto.randomUUID()}`;
  const first = await request.get('/health', { headers: { 'X-Correlation-Id': correlationId } });
  const second = await request.get('/health', { headers: { 'X-Correlation-Id': correlationId } });

  expect(first.headers()['x-correlation-id']).toBe(correlationId);
  expect(second.headers()['x-correlation-id']).toBe(correlationId);
  expect(first.headers()['x-request-id']).not.toBe(second.headers()['x-request-id']);
});

test('repete a mesma solicitação sem duplicar recurso', async ({ request }, testInfo) => {
  declareControl(
    testInfo,
    'Retry do cliente pode provisionar duas instâncias para uma intenção única.',
    'Reutilizar operação e recurso quando chave e payload forem repetidos.',
  );

  const key = `retry-${crypto.randomUUID()}`;
  const first = await request.post('/v1/instances', {
    headers: { 'Idempotency-Key': key },
    data: validInstanceRequest,
  });
  const second = await request.post('/v1/instances', {
    headers: { 'Idempotency-Key': key },
    data: validInstanceRequest,
  });

  expect(first.status()).toBe(202);
  expect(second.status()).toBe(202);
  expect(second.headers()['idempotency-replayed']).toBe('true');
  const [firstOperation, secondOperation] = await Promise.all([first.json(), second.json()]);
  expect(secondOperation.id).toBe(firstOperation.id);
  expect(secondOperation.resourceId).toBe(firstOperation.resourceId);
});

