/**
 * [LAB] Thresholds nominais de performance e capacidade para o Cloud Control Plane.
 * Não representam SLAs de produção da TOTVS.
 */

export const LAB_PERFORMANCE_THRESHOLDS = {
  maxErrorRate: 0.01,           // Taxa de erro HTTP < 1%
  maxP95Ms: 500,                // Latência p95 da API < 500ms
  maxP99Ms: 1000,               // Latência p99 da API < 1000ms
  maxE2eP95Ms: 5000,            // Duração p95 da jornada E2E < 5000ms
  maxDuplicateResources: 0,     // Zero duplicidade de instâncias
  maxDuplicateOperations: 0,    // Zero duplicidade de operações
  regressionTolerancePct: 0.20, // Regressão relevante = aumento > 20% em p95/p99
};

export const K6_API_THRESHOLDS = {
  http_req_failed: ['rate<0.01'],
  http_req_duration: ['p(95)<500', 'p(99)<1000'],
};

export const K6_JOURNEY_THRESHOLDS = {
  http_req_failed: ['rate<0.01'],
  http_req_duration: ['p(95)<500', 'p(99)<1000'],
  e2e_duration: ['p(95)<5000'],
};
