import { expect, test } from '@playwright/test';
import { declareControl } from '../helpers/quality.js';
import { runPerformanceSuite, type PerformanceEvidenceArtifact } from '../../performance/runner.js';
import { comparePerformanceBaseline } from '../../performance/baseline-comparator.js';
import { LAB_PERFORMANCE_THRESHOLDS } from '../../performance/thresholds.js';

test.describe.serial('LAB-09 — Performance & Baseline Quality Pack', () => {
  let artifact: PerformanceEvidenceArtifact;

  test.beforeAll(async () => {
    // Executa suite de performance em modo smoke para validação rápida e determinística do gate
    artifact = await runPerformanceSuite({ isSmoke: true });
  });

  // =========================================================================
  // Cenário 1: Latência sob concorrência moderada
  // =========================================================================
  test('Cenário 1: Latência p95 e p99 sob concorrência cumprem os thresholds nominais [LAB]', async ({}, testInfo) => {
    declareControl(testInfo, {
      riskId: 'RISK-PERF-001',
      risk: 'Degradação de latência sob concorrência moderada causa lentidão inaceitável nas requisições da API.',
      controlId: 'CTRL-PERF-LATENCY-001',
      control: 'Submeter carga moderada de VUs e validar que p95 < 500ms e p99 < 1000ms.',
    });

    expect(artifact.latency.p95).toBeLessThanOrEqual(LAB_PERFORMANCE_THRESHOLDS.maxP95Ms);
    expect(artifact.latency.p99).toBeLessThanOrEqual(LAB_PERFORMANCE_THRESHOLDS.maxP99Ms);
    expect(artifact.thresholds.p95Met).toBe(true);
    expect(artifact.thresholds.p99Met).toBe(true);
  });

  // =========================================================================
  // Cenário 2: Taxa de erro HTTP sob carga
  // =========================================================================
  test('Cenário 2: Taxa de erro HTTP sob carga permanece estritamente inferior a 1%', async ({}, testInfo) => {
    declareControl(testInfo, {
      riskId: 'RISK-PERF-002',
      risk: 'Aumento de requisições concorrentes provoca falhas transitórias de rede, timeouts ou erros 5xx na API.',
      controlId: 'CTRL-PERF-ERROR-RATE-001',
      control: 'Calcular taxa de requisições com falha sob carga e assegurar errorRate < 0.01.',
    });

    expect(artifact.errorRate).toBeLessThanOrEqual(LAB_PERFORMANCE_THRESHOLDS.maxErrorRate);
    expect(artifact.thresholds.errorRateMet).toBe(true);
  });

  // =========================================================================
  // Cenário 3: Idempotência sob concorrência
  // =========================================================================
  test('Cenário 3: Retentativas concorrentes simultâneas com a mesma chave preservam unicidade e zero duplicidade', async ({}, testInfo) => {
    declareControl(testInfo, {
      riskId: 'RISK-PERF-003',
      risk: 'Condição de corrida entre chamadas concorrentes com mesma Idempotency-Key gera recursos ou operações duplicadas no banco.',
      controlId: 'CTRL-PERF-IDEMPOTENCY-CONCURRENCY-001',
      control: 'Verificar no banco de dados que duplicateResources = 0 e duplicateOperations = 0.',
    });

    expect(artifact.duplicates.duplicateResources).toBe(0);
    expect(artifact.duplicates.duplicateOperations).toBe(0);
    expect(artifact.thresholds.duplicatesMet).toBe(true);
  });

  // =========================================================================
  // Cenário 4: Jornada E2E sob carga moderada
  // =========================================================================
  test('Cenário 4: Duração p95 da jornada assíncrona E2E sob concorrência cumpre o SLA [LAB]', async ({}, testInfo) => {
    declareControl(testInfo, {
      riskId: 'RISK-PERF-004',
      risk: 'A esteira assíncrona desacoplada (Outbox + NATS + Consumer) acumula filas excessivas ou estoura o SLA sob concorrência.',
      controlId: 'CTRL-PERF-E2E-THROUGHPUT-001',
      control: 'Medir tempo de ciclo completo de ponta a ponta e garantir e2eP95 < 5000ms.',
    });

    if (artifact.e2eLatency) {
      expect(artifact.e2eLatency.p95).toBeLessThanOrEqual(LAB_PERFORMANCE_THRESHOLDS.maxE2eP95Ms);
      expect(artifact.thresholds.e2eP95Met).toBe(true);
    }
  });

  // =========================================================================
  // Cenário 5: Comparação determinística contra baseline
  // =========================================================================
  test('Cenário 5: Comparação contra baseline histórica detecta estabilidade ou regressão determinística', async ({}, testInfo) => {
    declareControl(testInfo, {
      riskId: 'RISK-PERF-005',
      risk: 'Regressão silenciosa de throughput ou latência passa despercebida entre commits sem comparação contra baseline.',
      controlId: 'CTRL-PERF-BASELINE-REGRESSION-001',
      control: 'Comparar métricas da execução atual com baseline.json aplicando tolerância explícita de 20%.',
    });

    // Validar comportamento do comparador com caso sintético estável
    const syntheticComparison = comparePerformanceBaseline(
      {
        totalRequests: 100,
        requestsPerSecond: 25,
        successRate: 1,
        errorRate: 0,
        p50: 20,
        p95: 100,
        p99: 150,
        maxLatency: 200,
        duplicateResources: 0,
        duplicateOperations: 0,
      },
      {
        totalRequests: 100,
        requestsPerSecond: 24,
        successRate: 1,
        errorRate: 0,
        p50: 19,
        p95: 95,
        p99: 145,
        maxLatency: 190,
        duplicateResources: 0,
        duplicateOperations: 0,
      },
      0.20,
    );
    expect(syntheticComparison.status).toBe('STABLE');

    // Validar caso de regressão sintética
    const regressedComparison = comparePerformanceBaseline(
      {
        totalRequests: 100,
        requestsPerSecond: 10, // queda > 20%
        successRate: 0.9,
        errorRate: 0.1,
        p50: 50,
        p95: 250, // aumento > 20%
        p99: 400,
        maxLatency: 500,
        duplicateResources: 0,
        duplicateOperations: 0,
      },
      {
        totalRequests: 100,
        requestsPerSecond: 25,
        successRate: 1,
        errorRate: 0,
        p50: 20,
        p95: 100,
        p99: 150,
        maxLatency: 200,
        duplicateResources: 0,
        duplicateOperations: 0,
      },
      0.20,
    );
    expect(regressedComparison.status).toBe('REGRESSED');

    // Status da execução real não pode ser REGRESSED
    expect(artifact.baselineComparison.status).not.toBe('REGRESSED');
    expect(artifact.result).toBe('PASSED');
  });
});
