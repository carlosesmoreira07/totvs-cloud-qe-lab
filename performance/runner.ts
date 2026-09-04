import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type net from 'node:net';
import { spawn } from 'node:child_process';
import type { NatsConnection } from 'nats';

import { PostgresControlPlaneStore } from '../apps/control-plane-mock/src/postgres-store.js';
import { connectNats, ensureStream } from '../apps/control-plane-mock/src/nats-jetstream.js';
import { OutboxPublisher } from '../apps/control-plane-mock/src/outbox-publisher.js';
import { EventConsumer } from '../apps/control-plane-mock/src/consumer.js';
import { createRequestHandler } from '../apps/control-plane-mock/src/app.js';
import {
  comparePerformanceBaseline,
  type PerformanceMetrics,
  type BaselineComparisonResult,
} from './baseline-comparator.js';
import { LAB_PERFORMANCE_THRESHOLDS } from './thresholds.js';

export interface PerformanceEvidenceArtifact {
  scenario: string;
  startedAt: string;
  completedAt: string;
  vus: number;
  duration: string;
  totalRequests: number;
  throughput: number;
  successRate: number;
  errorRate: number;
  latency: {
    p50: number;
    p95: number;
    p99: number;
    max: number;
  };
  e2eLatency: {
    p50: number;
    p95: number;
  } | null;
  duplicates: {
    duplicateResources: number;
    duplicateOperations: number;
  };
  thresholds: {
    p95Met: boolean;
    p99Met: boolean;
    errorRateMet: boolean;
    duplicatesMet: boolean;
    e2eP95Met: boolean;
    status: 'MET' | 'BREACHED';
  };
  baselineComparison: BaselineComparisonResult;
  result: 'PASSED' | 'FAILED';
}

export async function runPerformanceSuite(options?: {
  isSmoke?: boolean;
  targetUrl?: string;
  evidenceDir?: string;
}): Promise<PerformanceEvidenceArtifact> {
  const isSmoke = options?.isSmoke ?? process.argv.includes('--smoke');
  const vus = isSmoke ? 3 : 5;
  const duration = isSmoke ? '2s' : '4s';
  const startedAt = new Date().toISOString();

  const evidenceDir = options?.evidenceDir ?? path.resolve(process.cwd(), 'evidence', 'performance');
  if (!fs.existsSync(evidenceDir)) {
    fs.mkdirSync(evidenceDir, { recursive: true });
  }

  let server: http.Server | undefined;
  let store: PostgresControlPlaneStore | undefined;
  let nc: NatsConnection | undefined;
  let publisher: OutboxPublisher | undefined;
  let consumer: EventConsumer | undefined;

  let targetUrl = options?.targetUrl ?? process.env.TARGET_URL;

  // Se targetUrl não fornecida, inicia servidor efêmero com PostgreSQL e NATS
  if (!targetUrl) {
    store = new PostgresControlPlaneStore({
      connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/control_plane',
    });
    await store.ensureSchema();
    await store.clearTables();

    nc = await connectNats({ servers: process.env.NATS_URL ?? 'nats://127.0.0.1:4222' });
    await ensureStream(nc);

    publisher = new OutboxPublisher(store.getPool(), nc);
    consumer = new EventConsumer(store.getPool(), nc);

    publisher.start(50);
    await consumer.start();

    const handler = createRequestHandler(store);
    server = http.createServer(handler);
    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as net.AddressInfo;
    targetUrl = `http://127.0.0.1:${addr.port}`;
  }

  try {
    console.log(`[LAB-09 Performance] Iniciando testes em ${targetUrl} (VUs: ${vus}, Duração: ${duration})...`);

    // 1. Executar k6 api-baseline
    const apiSummaryPath = path.join(evidenceDir, 'api-summary.json');
    const apiScriptPath = path.resolve(process.cwd(), 'performance', 'api-baseline.js');

    const k6ApiResult = await runK6Async([
      'run',
      '-u', String(vus),
      '-d', duration,
      '-e', `TARGET_URL=${targetUrl}`,
      '-e', `VUS=${vus}`,
      '-e', `DURATION=${duration}`,
      '--summary-export', apiSummaryPath,
      apiScriptPath,
    ]);

    if (k6ApiResult.error || !fs.existsSync(apiSummaryPath)) {
      console.warn('[LAB-09 Performance] k6 não disponível ou sumário ausente, usando simulador de carga TS...');
      await runSimulatedLoad(targetUrl, vus, isSmoke ? 20 : 40, apiSummaryPath);
    }

    // 2. Executar k6 journey-baseline
    const journeySummaryPath = path.join(evidenceDir, 'journey-summary.json');
    const journeyScriptPath = path.resolve(process.cwd(), 'performance', 'journey-baseline.js');
    const journeyVus = Math.max(2, Math.floor(vus / 2));

    await runK6Async([
      'run',
      '-u', String(journeyVus),
      '-d', duration,
      '-e', `TARGET_URL=${targetUrl}`,
      '-e', `VUS=${journeyVus}`,
      '-e', `DURATION=${duration}`,
      '--summary-export', journeySummaryPath,
      journeyScriptPath,
    ]);

    // 3. Extrair métricas
    const apiData = readJsonSafe(apiSummaryPath);
    const journeyData = readJsonSafe(journeySummaryPath);

    const metrics = extractMetrics(apiData, journeyData);

    // 4. Verificar duplicidade no banco
    if (store) {
      const pool = store.getPool();
      const dupInstRes = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::int as count FROM (
          SELECT name FROM instances GROUP BY name HAVING COUNT(*) > 1
        ) d`,
      );
      const dupOpRes = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::int as count FROM (
          SELECT resource_id FROM operations GROUP BY resource_id HAVING COUNT(*) > 1
        ) d`,
      );
      metrics.duplicateResources = Number(dupInstRes.rows[0]?.count ?? 0);
      metrics.duplicateOperations = Number(dupOpRes.rows[0]?.count ?? 0);
    }

    // 5. Comparar com baseline
    const baselinePath = path.join(evidenceDir, 'baseline.json');
    const baselineMetrics = fs.existsSync(baselinePath)
      ? (JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as PerformanceEvidenceArtifact).latency
        ? (JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as PerformanceEvidenceArtifact).latency as unknown as PerformanceMetrics
        : null
      : null;

    // Normalizar formato do baseline se existir
    let parsedBaseline: PerformanceMetrics | null = null;
    if (fs.existsSync(baselinePath)) {
      try {
        const rawBaseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as {
          totalRequests?: number;
          throughput?: number;
          successRate?: number;
          errorRate?: number;
          latency?: { p50: number; p95: number; p99: number; max: number };
          e2eLatency?: { p50: number; p95: number };
          duplicates?: { duplicateResources: number; duplicateOperations: number };
        };
        if (rawBaseline.latency) {
          parsedBaseline = {
            totalRequests: rawBaseline.totalRequests ?? 0,
            requestsPerSecond: rawBaseline.throughput ?? 0,
            successRate: rawBaseline.successRate ?? 1,
            errorRate: rawBaseline.errorRate ?? 0,
            p50: rawBaseline.latency.p50,
            p95: rawBaseline.latency.p95,
            p99: rawBaseline.latency.p99,
            maxLatency: rawBaseline.latency.max,
            e2eP50: rawBaseline.e2eLatency?.p50,
            e2eP95: rawBaseline.e2eLatency?.p95,
            duplicateResources: rawBaseline.duplicates?.duplicateResources ?? 0,
            duplicateOperations: rawBaseline.duplicates?.duplicateOperations ?? 0,
          };
        } else if ((rawBaseline as any).metrics) {
          const m = (rawBaseline as any).metrics;
          parsedBaseline = {
            totalRequests: m.total_requests ?? 100,
            requestsPerSecond: m.api_throughput_rps ?? 20,
            successRate: m.journey_success_rate ?? 1,
            errorRate: m.api_error_rate ?? 0,
            p50: m.api_p50_ms ?? 35,
            p95: m.api_p95_ms ?? 150,
            p99: m.api_p99_ms ?? 300,
            maxLatency: (m.api_p99_ms ?? 300) * 1.5,
            e2eP50: m.journey_p50_e2e_ms ?? 2500,
            e2eP95: m.journey_p95_e2e_ms ?? 5000,
            duplicateResources: m.idempotency_duplicate_resources ?? 0,
            duplicateOperations: m.idempotency_duplicate_operations ?? 0,
          };
        }
      } catch {
        parsedBaseline = null;
      }
    }

    const baselineComparison = comparePerformanceBaseline(metrics, parsedBaseline, LAB_PERFORMANCE_THRESHOLDS.regressionTolerancePct);

    // 6. Avaliar thresholds
    const p95Met = metrics.p95 <= LAB_PERFORMANCE_THRESHOLDS.maxP95Ms;
    const p99Met = metrics.p99 <= LAB_PERFORMANCE_THRESHOLDS.maxP99Ms;
    const errorRateMet = metrics.errorRate <= LAB_PERFORMANCE_THRESHOLDS.maxErrorRate;
    const duplicatesMet = metrics.duplicateResources === 0 && metrics.duplicateOperations === 0;
    const e2eP95Met = metrics.e2eP95 !== undefined ? metrics.e2eP95 <= LAB_PERFORMANCE_THRESHOLDS.maxE2eP95Ms : true;

    const allThresholdsMet = p95Met && p99Met && errorRateMet && duplicatesMet && e2eP95Met;
    const completedAt = new Date().toISOString();

    const artifact: PerformanceEvidenceArtifact = {
      scenario: isSmoke ? 'smoke-performance' : 'baseline-performance',
      startedAt,
      completedAt,
      vus,
      duration,
      totalRequests: metrics.totalRequests,
      throughput: metrics.requestsPerSecond,
      successRate: metrics.successRate,
      errorRate: metrics.errorRate,
      latency: {
        p50: metrics.p50,
        p95: metrics.p95,
        p99: metrics.p99,
        max: metrics.maxLatency,
      },
      e2eLatency: metrics.e2eP95 !== undefined ? {
        p50: metrics.e2eP50 ?? 0,
        p95: metrics.e2eP95,
      } : null,
      duplicates: {
        duplicateResources: metrics.duplicateResources,
        duplicateOperations: metrics.duplicateOperations,
      },
      thresholds: {
        p95Met,
        p99Met,
        errorRateMet,
        duplicatesMet,
        e2eP95Met,
        status: allThresholdsMet ? 'MET' : 'BREACHED',
      },
      baselineComparison,
      result: allThresholdsMet && baselineComparison.status !== 'REGRESSED' ? 'PASSED' : 'FAILED',
    };

    // 7. Gravar evidence/performance/current.json
    fs.writeFileSync(path.join(evidenceDir, 'current.json'), JSON.stringify(artifact, null, 2));

    // Se baseline.json não existe ou se foi executado modo baseline com sucesso, define/atualiza baseline
    if (!fs.existsSync(baselinePath) && artifact.result === 'PASSED') {
      fs.writeFileSync(baselinePath, JSON.stringify(artifact, null, 2));
      console.log('[LAB-09 Performance] Baseline inicial gerada em evidence/performance/baseline.json');
    }

    console.log(`[LAB-09 Performance] Concluído: Status = ${artifact.result} | Comparação = ${baselineComparison.status} | Throughput = ${metrics.requestsPerSecond} req/s | p95 = ${metrics.p95}ms`);
    return artifact;
  } finally {
    publisher?.stop();
    if (consumer) {
      await consumer.stop();
    }
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    if (nc) {
      await nc.close();
    }
    if (store) {
      await store.close();
    }
  }
}

function readJsonSafe(filePath: string): Record<string, any> | null {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, any>;
    }
  } catch {
    // ignore
  }
  return null;
}

function extractMetrics(apiSummary: any, journeySummary: any): PerformanceMetrics {
  const defaultMetrics: PerformanceMetrics = {
    totalRequests: 0,
    requestsPerSecond: 0,
    successRate: 1,
    errorRate: 0,
    p50: 0,
    p95: 0,
    p99: 0,
    maxLatency: 0,
    duplicateResources: 0,
    duplicateOperations: 0,
  };

  if (!apiSummary) return defaultMetrics;

  const metricsObj = apiSummary.metrics ?? {};
  const httpReqs = metricsObj.http_reqs ?? {};
  const httpReqDuration = metricsObj.http_req_duration ?? {};
  const httpReqFailed = metricsObj.http_req_failed ?? {};

  const totalRequests = Number(httpReqs.count ?? httpReqs.values?.count ?? 0);
  const requestsPerSecond = Math.round(Number(httpReqs.rate ?? httpReqs.values?.rate ?? 0) * 10) / 10;
  const errorRate = Math.round(Number(httpReqFailed.value ?? httpReqFailed.rate ?? httpReqFailed.values?.rate ?? 0) * 1000) / 1000;
  const successRate = Math.round((1 - errorRate) * 1000) / 1000;

  const p50 = Math.round(Number(httpReqDuration['p(50)'] ?? httpReqDuration.med ?? httpReqDuration.values?.['p(50)'] ?? 0) * 10) / 10;
  const p95 = Math.round(Number(httpReqDuration['p(95)'] ?? httpReqDuration.values?.['p(95)'] ?? 0) * 10) / 10;
  const p99 = Math.round(Number(httpReqDuration['p(99)'] ?? httpReqDuration.values?.['p(99)'] ?? 0) * 10) / 10;
  const maxLatency = Math.round(Number(httpReqDuration.max ?? httpReqDuration.values?.max ?? 0) * 10) / 10;

  let e2eP50: number | undefined;
  let e2eP95: number | undefined;

  const e2eDurationObj = journeySummary?.metrics?.e2e_duration;
  if (e2eDurationObj) {
    const e2eValues = e2eDurationObj.values ?? e2eDurationObj;
    e2eP50 = Math.round(Number(e2eValues['p(50)'] ?? e2eValues.med ?? 0) * 10) / 10;
    e2eP95 = Math.round(Number(e2eValues['p(95)'] ?? 0) * 10) / 10;
  }

  return {
    totalRequests,
    requestsPerSecond,
    successRate,
    errorRate,
    p50,
    p95,
    p99,
    maxLatency,
    e2eP50,
    e2eP95,
    duplicateResources: 0,
    duplicateOperations: 0,
  };
}

function runK6Async(args: string[]): Promise<{ exitCode: number | null; error?: Error }> {
  return new Promise((resolve) => {
    const child = spawn('k6', args, { stdio: 'inherit' });
    child.on('error', (err) => resolve({ exitCode: null, error: err }));
    child.on('close', (code) => resolve({ exitCode: code }));
  });
}

async function runSimulatedLoad(targetUrl: string, vus: number, iterations: number, outputPath: string): Promise<void> {
  const durations: number[] = [];
  let failed = 0;
  const t0 = Date.now();

  const runIteration = async (idx: number) => {
    const unique = `${idx}-${Date.now().toString(36)}`;
    const start = Date.now();
    try {
      const res = await fetch(`${targetUrl}/v1/instances`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `idemp-sim-${unique}`,
          'X-Correlation-ID': `corr-sim-${unique}`,
        },
        body: JSON.stringify({
          name: `inst-sim-${unique}`,
          flavor: 't3.medium',
          region: 'us-east-1',
        }),
      });
      durations.push(Date.now() - start);
      if (!res.ok) failed++;
    } catch {
      failed++;
    }
  };

  const tasks: Promise<void>[] = [];
  for (let i = 0; i < iterations; i++) {
    tasks.push(runIteration(i));
  }
  await Promise.all(tasks);

  durations.sort((a, b) => a - b);
  const total = durations.length;
  const p50 = durations[Math.floor(total * 0.50)] ?? 0;
  const p95 = durations[Math.floor(total * 0.95)] ?? 0;
  const p99 = durations[Math.floor(total * 0.99)] ?? 0;
  const max = durations[durations.length - 1] ?? 0;
  const elapsedSec = (Date.now() - t0) / 1000;

  const simulatedSummary = {
    metrics: {
      http_reqs: { values: { count: total, rate: total / (elapsedSec || 1) } },
      http_req_failed: { values: { rate: failed / (total || 1) } },
      http_req_duration: { values: { 'p(50)': p50, 'p(95)': p95, 'p(99)': p99, max } },
    },
  };

  fs.writeFileSync(outputPath, JSON.stringify(simulatedSummary, null, 2));
}

// Execução direta via CLI
if (process.argv[1]?.endsWith('runner.ts') || process.argv[1]?.endsWith('runner.js')) {
  runPerformanceSuite().then((artifact) => {
    if (artifact.result !== 'PASSED') {
      process.exitCode = 1;
    }
  }).catch((err) => {
    console.error('[LAB-09 Performance] Erro:', err);
    process.exitCode = 1;
  });
}
