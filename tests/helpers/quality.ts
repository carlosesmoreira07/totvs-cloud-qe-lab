import { expect, type APIRequestContext, type APIResponse, type TestInfo } from '@playwright/test';

interface QualityControl {
  riskId: string;
  risk: string;
  controlId: string;
  control: string;
}

export function declareControl(testInfo: TestInfo, metadata: QualityControl): void {
  testInfo.annotations.push(
    { type: 'risk_id', description: metadata.riskId },
    { type: 'risk', description: metadata.risk },
    { type: 'control_id', description: metadata.controlId },
    { type: 'control', description: metadata.control },
  );
}

export async function waitForOperation(
  request: APIRequestContext,
  operationId: string,
  expectedStatus = 'SUCCEEDED',
): Promise<Record<string, unknown>> {
  let lastOperation: Record<string, unknown> = {};
  await expect
    .poll(async () => {
      const response = await request.get(`/v1/operations/${operationId}`);
      expect(response.status()).toBe(200);
      lastOperation = await response.json() as Record<string, unknown>;
      return lastOperation.status;
    })
    .toBe(expectedStatus);
  return lastOperation;
}

export async function expectJsonError(
  response: APIResponse,
  expectedStatus: number,
  expectedCode: string,
): Promise<void> {
  expect(response.status()).toBe(expectedStatus);
  expect(response.headers()['content-type']).toContain('application/json');
  expect(response.headers()['x-correlation-id']).toBeTruthy();
  expect(response.headers()['x-request-id']).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  await expect(response.json()).resolves.toMatchObject({ code: expectedCode });
}

export const validInstanceRequest = {
  name: 'qe-lab-instance',
  region: 'lab-region-1',
  image: 'linux-lab-image',
  flavor: 'lab-small',
};
