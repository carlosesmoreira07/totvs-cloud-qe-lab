import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import { K6_JOURNEY_THRESHOLDS } from './thresholds.js';

const e2eDuration = new Trend('e2e_duration', true);
const journeyErrors = new Counter('journey_errors');

export const options = {
  thresholds: K6_JOURNEY_THRESHOLDS,
  vus: Number(__ENV.VUS || 5),
  duration: __ENV.DURATION || '5s',
};

const BASE_URL = __ENV.TARGET_URL || 'http://127.0.0.1:4010';

export default function () {
  const uniqueSuffix = `${__VU}-${__ITER}-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
  const idempotencyKey = `idemp-journey-k6-${uniqueSuffix}`;
  const correlationId = `corr-journey-k6-${uniqueSuffix}`;

  const payload = JSON.stringify({
    name: `inst-journey-${uniqueSuffix}`,
    flavor: 't3.medium',
    image: 'ami-ubuntu-22.04',
    region: 'us-east-1',
  });

  const headers = {
    'Content-Type': 'application/json',
    'Idempotency-Key': idempotencyKey,
    'X-Correlation-ID': correlationId,
  };

  const t0 = Date.now();

  // 1. Submeter POST /v1/instances
  const res = http.post(`${BASE_URL}/v1/instances`, payload, { headers });

  let operationId = '';
  const accepted = check(res, {
    'post accepted 202': (r) => r.status === 202,
    'operation returned': (r) => {
      try {
        const body = JSON.parse(r.body);
        operationId = body.id;
        return Boolean(operationId);
      } catch {
        return false;
      }
    },
  });

  if (!accepted || !operationId) {
    journeyErrors.add(1);
    return;
  }

  // 2. Polling da operação até conclusão SUCCEEDED
  let succeeded = false;
  const maxAttempts = 25;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    sleep(0.1);
    const opRes = http.get(`${BASE_URL}/v1/operations/${operationId}`);
    if (opRes.status === 200) {
      try {
        const opData = JSON.parse(opRes.body);
        if (opData.status === 'SUCCEEDED') {
          succeeded = true;
          break;
        }
      } catch {
        // retry polling
      }
    }
  }

  const totalE2eMs = Date.now() - t0;
  e2eDuration.add(totalE2eMs);

  check(succeeded, {
    'operation converged to SUCCEEDED': (s) => s === true,
  });

  if (!succeeded) {
    journeyErrors.add(1);
  }

  sleep(0.05);
}

export function handleSummary(data) {
  return {
    'evidence/performance/journey-summary.json': JSON.stringify(data),
  };
}
