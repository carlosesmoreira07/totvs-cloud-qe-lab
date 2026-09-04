import { expect, test, type APIResponse } from '@playwright/test';

import { declareControl, validInstanceRequest } from '../helpers/quality.js';

const INTERNAL_DETAIL_PATTERN = /(stack|stacktrace|node_modules|postgres|nats:\/\/|database_url|process\.env|at\s+\w+\s+\()/i;
const CREDENTIAL_PATTERN = /(sk-[a-z0-9_-]{10,}|gh[pousr]_[a-z0-9]{20,}|akia[a-z0-9]{16}|bearer\s+[a-z0-9._~-]+)/i;

async function expectControlledJsonError(response: APIResponse, status: number, code: string): Promise<void> {
  expect(response.status()).toBe(status);
  expect(response.status()).toBeLessThan(500);
  expect(response.headers()['content-type']).toContain('application/json');
  expect(response.headers()['x-content-type-options']).toBe('nosniff');
  expect(response.headers()['x-frame-options']).toBe('DENY');
  const raw = await response.text();
  expect(raw).not.toMatch(INTERNAL_DETAIL_PATTERN);
  expect(raw).not.toMatch(CREDENTIAL_PATTERN);
  expect(JSON.parse(raw)).toMatchObject({ code });
}

test('payload inválido é rejeitado sem erro interno nem detalhes sensíveis', async ({ request }, testInfo) => {
  declareControl(testInfo, {
    riskId: 'RISK-SEC-005',
    risk: 'Entrada inválida pode alcançar processamento interno, provocar 5xx ou expor diagnóstico sensível.',
    controlId: 'CTRL-SEC-API-INPUT-001',
    control: 'Submeter campos inválidos e inesperados e exigir erro 4xx estruturado, sem stack ou credencial.',
  });

  const response = await request.post('/v1/instances', {
    headers: { 'Idempotency-Key': `security-${crypto.randomUUID()}` },
    data: { name: '<script>alert(1)</script>', region: '', unexpected: '../../../etc/passwd' },
  });
  await expectControlledJsonError(response, 400, 'INVALID_REQUEST');
});

test('JSON malformado produz falha controlada e diagnosticável', async ({ request }, testInfo) => {
  declareControl(testInfo, {
    riskId: 'RISK-SEC-005',
    risk: 'Parser pode transformar corpo malformado em exceção 500 ou revelar implementação.',
    controlId: 'CTRL-SEC-API-INPUT-001',
    control: 'Enviar JSON truncado e exigir INVALID_JSON sem stack trace.',
  });

  const response = await request.post('/v1/instances', {
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `security-${crypto.randomUUID()}`,
    },
    data: Buffer.from('{"name":', 'utf8'),
  });
  await expectControlledJsonError(response, 400, 'INVALID_JSON');
});

test('headers inesperados não alteram a resposta nem são refletidos', async ({ request }, testInfo) => {
  declareControl(testInfo, {
    riskId: 'RISK-SEC-006',
    risk: 'Headers não confiáveis podem ser refletidos ou revelar stack e componentes internos.',
    controlId: 'CTRL-SEC-API-DISCLOSURE-001',
    control: 'Enviar headers inesperados e verificar resposta mínima, protegida e sem reflexão.',
  });

  const marker = `not-reflected-${crypto.randomUUID()}`;
  const response = await request.get('/health', {
    headers: { 'X-Forwarded-Host': marker, 'X-Debug-Mode': 'true' },
  });
  expect(response.status()).toBe(200);
  expect(await response.text()).not.toContain(marker);
  expect(JSON.stringify(response.headers())).not.toContain(marker);
  expect(response.headers().server).toBeUndefined();
  expect(response.headers()['x-powered-by']).toBeUndefined();
});

test('recurso inexistente mantém erro consistente sem enumeração sensível', async ({ request }, testInfo) => {
  declareControl(testInfo, {
    riskId: 'RISK-SEC-006',
    risk: 'Consulta inexistente pode expor tecnologia, caminho interno ou detalhe de armazenamento.',
    controlId: 'CTRL-SEC-API-DISCLOSURE-001',
    control: 'Consultar UUID ausente e exigir Error mínimo sem dado interno.',
  });

  const response = await request.get(`/v1/instances/${crypto.randomUUID()}`);
  await expectControlledJsonError(response, 404, 'INSTANCE_NOT_FOUND');
  await expect(response.json()).resolves.toMatchObject({ message: 'Instance was not found' });
});

test('corpo acima do limite recebe 413 sem derrubar o serviço', async ({ request }, testInfo) => {
  declareControl(testInfo, {
    riskId: 'RISK-SEC-005',
    risk: 'Corpo excessivo pode consumir recursos sem limite ou resultar em falha interna.',
    controlId: 'CTRL-SEC-API-INPUT-001',
    control: 'Enviar corpo acima de 16 KiB e exigir PAYLOAD_TOO_LARGE controlado.',
  });

  const response = await request.post('/v1/instances', {
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `security-${crypto.randomUUID()}`,
    },
    data: JSON.stringify({ ...validInstanceRequest, image: 'x'.repeat(17_000) }),
  });
  await expectControlledJsonError(response, 413, 'PAYLOAD_TOO_LARGE');
  const health = await request.get('/health');
  expect(health.status()).toBe(200);
});

test('content type incompatível é recusado antes do provisionamento', async ({ request }, testInfo) => {
  declareControl(testInfo, {
    riskId: 'RISK-SEC-005',
    risk: 'Content-Type ambíguo pode acionar parser indevido ou validação inconsistente.',
    controlId: 'CTRL-SEC-API-INPUT-001',
    control: 'Enviar JSON declarado como text/plain e exigir 415 UNSUPPORTED_MEDIA_TYPE.',
  });

  const response = await request.post('/v1/instances', {
    headers: {
      'Content-Type': 'text/plain',
      'Idempotency-Key': `security-${crypto.randomUUID()}`,
    },
    data: JSON.stringify(validInstanceRequest),
  });
  await expectControlledJsonError(response, 415, 'UNSUPPORTED_MEDIA_TYPE');
});

test('IDs diagnósticos não têm formato de credencial e headers defensivos estão presentes', async ({ request }, testInfo) => {
  declareControl(testInfo, {
    riskId: 'RISK-SEC-006',
    risk: 'Identificadores ou respostas podem carregar segredo e omitir proteção HTTP básica aplicável ao mock.',
    controlId: 'CTRL-SEC-API-DISCLOSURE-001',
    control: 'Inspecionar IDs e headers em resposta válida, rejeitando padrões de credencial conhecidos.',
  });

  const correlationId = `security-correlation-${crypto.randomUUID()}`;
  const response = await request.get('/health', { headers: { 'X-Correlation-Id': correlationId } });
  expect(response.status()).toBe(200);
  expect(response.headers()['x-correlation-id']).toBe(correlationId);
  expect(response.headers()['x-request-id']).toMatch(/^[0-9a-f-]{36}$/i);
  expect(response.headers()['x-content-type-options']).toBe('nosniff');
  expect(response.headers()['x-frame-options']).toBe('DENY');
  expect(response.headers()['content-security-policy']).toContain("default-src 'none'");
  expect(response.headers()['cross-origin-resource-policy']).toBe('same-origin');
  expect(response.headers()['cache-control']).toBe('no-store');
  expect(JSON.stringify({ headers: response.headers(), body: await response.json() })).not.toMatch(CREDENTIAL_PATTERN);
});
