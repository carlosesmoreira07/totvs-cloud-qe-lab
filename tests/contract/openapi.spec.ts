import path from 'node:path';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import { expect, test } from '@playwright/test';
import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';
import { declareControl, validInstanceRequest } from '../helpers/quality.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const specPath = path.join(repositoryRoot, 'specs/openapi/cloud-control-plane.yaml');

test('a especificação OpenAPI é válida e resolvível', async ({}, testInfo) => {
  declareControl(
    testInfo,
    'Um contrato inválido pode impedir geração de clientes e esconder divergências.',
    'Validar a OpenAPI 3.1 e resolver todas as referências locais.',
  );

  const api = (await SwaggerParser.validate(specPath)) as {
    openapi: string;
    info: { version: string };
    paths?: Record<string, unknown>;
  };
  expect(api.openapi).toBe('3.1.0');
  expect(api.info.version).toBe('0.1.0');
  expect(Object.keys(api.paths ?? {})).toEqual(
    expect.arrayContaining(['/health', '/v1/instances', '/v1/instances/{id}', '/v1/operations/{id}']),
  );
});

test('respostas centrais obedecem aos schemas publicados', async ({ request }, testInfo) => {
  declareControl(
    testInfo,
    'O mock pode retornar corpos incompatíveis apesar de status HTTP corretos.',
    'Validar respostas reais de Health, Operation, Instance e Error contra os schemas OpenAPI.',
  );

  const api = (await SwaggerParser.dereference(specPath)) as {
    components: { schemas: Record<string, AnySchema> };
  };
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const addFormats = addFormatsImport as unknown as (instance: Ajv2020) => Ajv2020;
  addFormats(ajv);
  const validate = (schemaName: string, body: unknown): void => {
    const validator = ajv.compile(api.components.schemas[schemaName]!);
    expect(validator(body), JSON.stringify(validator.errors, null, 2)).toBe(true);
  };

  const healthResponse = await request.get('/health');
  expect(healthResponse.status()).toBe(200);
  validate('Health', await healthResponse.json());

  const createResponse = await request.post('/v1/instances', {
    headers: { 'Idempotency-Key': `contract-${crypto.randomUUID()}` },
    data: validInstanceRequest,
  });
  expect(createResponse.status()).toBe(202);
  const operation = await createResponse.json();
  validate('Operation', operation);

  await expect
    .poll(async () => {
      const response = await request.get(`/v1/operations/${operation.id}`);
      const body = await response.json();
      validate('Operation', body);
      return body.status;
    })
    .toBe('SUCCEEDED');

  const instanceResponse = await request.get(`/v1/instances/${operation.resourceId}`);
  validate('Instance', await instanceResponse.json());

  const missingResponse = await request.get(`/v1/operations/${crypto.randomUUID()}`);
  expect(missingResponse.status()).toBe(404);
  validate('Error', await missingResponse.json());
});
