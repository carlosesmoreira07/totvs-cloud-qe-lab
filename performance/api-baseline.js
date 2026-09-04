import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { K6_API_THRESHOLDS } from './thresholds.js';

const duplicateErrors = new Counter('duplicate_errors');
const apiLatencyTrend = new Trend('api_latency_custom', true);

export const options = {
  thresholds: K6_API_THRESHOLDS,
  vus: Number(__ENV.VUS || 5),
  duration: __ENV.DURATION || '5s',
};

const BASE_URL = __ENV.TARGET_URL || 'http://127.0.0.1:4010';

export default function () {
  const uniqueSuffix = `${__VU}-${__ITER}-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
  const idempotencyKey = `idemp-k6-${uniqueSuffix}`;
  const correlationId = `corr-k6-${uniqueSuffix}`;

  const payload = JSON.stringify({
    name: `inst-k6-${uniqueSuffix}`,
    flavor: 't3.medium',
    image: 'ami-ubuntu-22.04',
    region: 'us-east-1',
  });

  const headers = {
    'Content-Type': 'application/json',
    'Idempotency-Key': idempotencyKey,
    'X-Correlation-ID': correlationId,
  };

  // 1. Requisição inicial de provisionamento
  const start = Date.now();
  const res = http.post(`${BASE_URL}/v1/instances`, payload, { headers });
  apiLatencyTrend.add(Date.now() - start);

  let initialResourceId = '';
  let initialOperationId = '';

  const ok = check(res, {
    'status is 202': (r) => r.status === 202,
    'has operation and resourceId': (r) => {
      try {
        const body = JSON.parse(r.body);
        initialResourceId = body.resourceId;
        initialOperationId = body.id;
        return Boolean(initialResourceId && initialOperationId);
      } catch {
        return false;
      }
    },
  });

  if (!ok) {
    duplicateErrors.add(1);
  }

  // 2. Teste de concorrência e idempotência imediata com a mesma chave
  const repeatRes = http.post(`${BASE_URL}/v1/instances`, payload, { headers });
  check(repeatRes, {
    'replay status is 202': (r) => r.status === 202,
    'replay header is true': (r) => r.headers['Idempotency-Replayed'] === 'true',
    'replay preserves resourceId': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.resourceId === initialResourceId;
      } catch {
        return false;
      }
    },
  });

  sleep(0.05);
}

export function handleSummary(data) {
  return {
    'evidence/performance/api-summary.json': JSON.stringify(data),
  };
}
