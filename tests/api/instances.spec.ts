import { expect, test } from '@playwright/test';
import {
  declareControl,
  expectJsonError,
  validInstanceRequest,
  waitForOperation,
} from '../helpers/quality.js';

test('cria uma instância válida e conclui a operação assíncrona', async ({ request }, testInfo) => {
  declareControl(testInfo, {
    riskId: 'RISK-API-007',
    risk: 'Uma solicitação válida pode ser aceita sem produzir um recurso consultável.',
    controlId: 'CTRL-ASYNC-001',
    control: 'Criar, acompanhar a operação até SUCCEEDED e consultar a instância RUNNING.',
  });

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

  await waitForOperation(request, operation.id);

  const instanceResponse = await request.get(`/v1/instances/${operation.resourceId}`);
  expect(instanceResponse.status()).toBe(200);
  await expect(instanceResponse.json()).resolves.toMatchObject({
    ...validInstanceRequest,
    id: operation.resourceId,
    status: 'RUNNING',
  });
});

test('rejeita payload inválido com erro diagnosticável', async ({ request }, testInfo) => {
  declareControl(testInfo, {
    riskId: 'RISK-API-002',
    risk: 'Dados incompletos podem iniciar provisionamento ambíguo ou inconsistente.',
    controlId: 'CTRL-REQUEST-001',
    control: 'Rejeitar o payload antes de criar a operação e listar os campos inválidos.',
  });

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
  declareControl(testInfo, {
    riskId: 'RISK-API-003',
    risk: 'Ausência de recurso pode ser confundida com indisponibilidade ou resposta vazia.',
    controlId: 'CTRL-NOTFOUND-001',
    control: 'Responder 404 com Error estruturado e IDs de diagnóstico.',
  });

  const response = await request.get(`/v1/instances/${crypto.randomUUID()}`);
  await expectJsonError(response, 404, 'INSTANCE_NOT_FOUND');
  await expect(response.json()).resolves.toMatchObject({ message: 'Instance was not found' });
});

test('preserva correlation ID e gera request ID único', async ({ request }, testInfo) => {
  declareControl(testInfo, {
    riskId: 'RISK-API-004',
    risk: 'Tentativas independentes podem ficar sem rastreabilidade entre chamadas.',
    controlId: 'CTRL-CORRELATION-001',
    control: 'Ecoar X-Correlation-Id e gerar um X-Request-Id por requisição.',
  });

  const correlationId = `journey-${crypto.randomUUID()}`;
  const first = await request.get('/health', { headers: { 'X-Correlation-Id': correlationId } });
  const second = await request.get('/health', { headers: { 'X-Correlation-Id': correlationId } });

  expect(first.headers()['x-correlation-id']).toBe(correlationId);
  expect(second.headers()['x-correlation-id']).toBe(correlationId);
  expect(first.headers()['x-request-id']).not.toBe(second.headers()['x-request-id']);
});

