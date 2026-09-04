import { expect, type APIResponse, type TestInfo } from '@playwright/test';

export function declareControl(testInfo: TestInfo, risk: string, control: string): void {
  testInfo.annotations.push(
    { type: 'risk', description: risk },
    { type: 'control', description: control },
  );
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

