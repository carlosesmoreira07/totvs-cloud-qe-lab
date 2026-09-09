import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  captureHistorySnapshot,
  writeSnapshotFile,
} from '../../tools/history/history-snapshot.js';
import {
  buildHistoryAndTrends,
  loadSnapshotsFromDirectory,
} from '../../tools/history/history-builder.js';
import {
  historyFileSchema,
  historySnapshotSchema,
  parseHistoryFile,
  parseHistorySnapshot,
  parseTrendsFile,
  trendsFileSchema,
  type HistorySnapshot,
} from '../../tools/history/history-schema.js';
import { calculateHistoricalTrends } from '../../tools/history/trend-calculator.js';

function baseSnapshot(overrides: Partial<HistorySnapshot> = {}): HistorySnapshot {
  return {
    timestamp: '2026-09-04T12:00:00.000Z',
    commitSha: 'commit-001',
    overallStatus: 'GREEN',
    riskCoverage: {
      knownRisks: 20,
      exercisedRisks: 16,
      coveragePct: 80,
    },
    controlsPassed: 16,
    controlsFailed: 0,
    journeysPassed: 4,
    journeysFailed: 0,
    slaMet: 4,
    slaBreached: 0,
    resiliencePassed: 6,
    resilienceFailed: 0,
    recoveryDuration: { minMs: 30, avgMs: 40, maxMs: 50 },
    observabilityStatus: 'GREEN',
    performanceStatus: 'GREEN',
    apiP95: 150,
    apiP99: 300,
    regressionStatus: 'GREEN',
    securityStatus: 'GREEN',
    securityFindings: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    knownGaps: ['Gap A', 'Gap B'],
    ...overrides,
  };
}

test('0 snapshots -> canCalculateTrend false, comparação UNKNOWN e tendências UNKNOWN', () => {
  const result = calculateHistoricalTrends([]);
  assert.equal(result.checkpointsAnalyzed, 0);
  assert.equal(result.canCalculateTrend, false);
  assert.equal(result.overallTrend, 'UNKNOWN');
  assert.equal(result.comparisonStatus, 'UNKNOWN');
  for (const dim of result.dimensions) {
    assert.equal(dim.historicalTrend, 'UNKNOWN');
    assert.equal(dim.comparisonStatus, 'UNKNOWN');
  }
  assert.ok(result.disclaimer.includes('Histórico insuficiente'));
  assert.equal(parseTrendsFile(result).schemaVersion, '1.0.0');
});

test('1 snapshot -> canCalculateTrend false, comparação NO_PREVIOUS_CHECKPOINT e tendências UNKNOWN', () => {
  const snapshot = baseSnapshot();
  const result = calculateHistoricalTrends([snapshot]);
  assert.equal(result.checkpointsAnalyzed, 1);
  assert.equal(result.canCalculateTrend, false);
  assert.equal(result.overallTrend, 'UNKNOWN');
  assert.equal(result.comparisonStatus, 'NO_PREVIOUS_CHECKPOINT');
  for (const dim of result.dimensions) {
    assert.equal(dim.historicalTrend, 'UNKNOWN');
    assert.equal(dim.comparisonStatus, 'NO_PREVIOUS_CHECKPOINT');
  }
});

test('2 snapshots -> comparação pontual disponível entre último e penúltimo, mas tendência estritamente UNKNOWN', () => {
  const s1 = baseSnapshot({ timestamp: '2026-09-04T12:00:00.000Z', controlsPassed: 16 });
  const s2 = baseSnapshot({ timestamp: '2026-09-05T12:00:00.000Z', controlsPassed: 18 });
  const result = calculateHistoricalTrends([s1, s2]);

  assert.equal(result.checkpointsAnalyzed, 2);
  assert.equal(result.canCalculateTrend, false);
  assert.equal(result.overallTrend, 'UNKNOWN');
  assert.equal(result.comparisonStatus, 'STABLE');

  const controls = result.dimensions.find((d) => d.dimension === 'CONTROLS');
  assert.equal(controls?.comparisonStatus, 'IMPROVED');
  assert.equal(controls?.historicalTrend, 'UNKNOWN');
});

test('>= 3 snapshots com evolução de riscos e controles produz tendência global e dimensional IMPROVING', () => {
  const s1 = baseSnapshot({
    timestamp: '2026-09-01T12:00:00.000Z',
    riskCoverage: { knownRisks: 20, exercisedRisks: 14, coveragePct: 70 },
    controlsPassed: 14,
  });
  const s2 = baseSnapshot({
    timestamp: '2026-09-02T12:00:00.000Z',
    riskCoverage: { knownRisks: 20, exercisedRisks: 16, coveragePct: 80 },
    controlsPassed: 16,
  });
  const s3 = baseSnapshot({
    timestamp: '2026-09-03T12:00:00.000Z',
    riskCoverage: { knownRisks: 20, exercisedRisks: 18, coveragePct: 90 },
    controlsPassed: 18,
  });

  const result = calculateHistoricalTrends([s1, s2, s3]);
  assert.equal(result.checkpointsAnalyzed, 3);
  assert.equal(result.canCalculateTrend, true);
  assert.equal(result.overallTrend, 'IMPROVING');

  const coverage = result.dimensions.find((d) => d.dimension === 'RISK_COVERAGE');
  assert.equal(coverage?.historicalTrend, 'IMPROVING');

  const controls = result.dimensions.find((d) => d.dimension === 'CONTROLS');
  assert.equal(controls?.historicalTrend, 'IMPROVING');
});

test('>= 3 snapshots estáveis e sem regressão produz tendência STABLE', () => {
  const s1 = baseSnapshot({ timestamp: '2026-09-01T12:00:00.000Z' });
  const s2 = baseSnapshot({ timestamp: '2026-09-02T12:00:00.000Z' });
  const s3 = baseSnapshot({ timestamp: '2026-09-03T12:00:00.000Z' });

  const result = calculateHistoricalTrends([s1, s2, s3]);
  assert.equal(result.checkpointsAnalyzed, 3);
  assert.equal(result.canCalculateTrend, true);
  assert.equal(result.overallTrend, 'STABLE');

  for (const dim of result.dimensions) {
    assert.equal(dim.historicalTrend, 'STABLE');
  }
});

test('>= 3 snapshots com falhas em controles ou jornadas produz tendência DEGRADING', () => {
  const s1 = baseSnapshot({ timestamp: '2026-09-01T12:00:00.000Z', controlsFailed: 0 });
  const s2 = baseSnapshot({ timestamp: '2026-09-02T12:00:00.000Z', controlsFailed: 0 });
  const s3 = baseSnapshot({
    timestamp: '2026-09-03T12:00:00.000Z',
    controlsFailed: 2,
    overallStatus: 'RED',
  });

  const result = calculateHistoricalTrends([s1, s2, s3]);
  assert.equal(result.checkpointsAnalyzed, 3);
  assert.equal(result.canCalculateTrend, true);
  assert.equal(result.overallTrend, 'DEGRADING');

  const controls = result.dimensions.find((d) => d.dimension === 'CONTROLS');
  assert.equal(controls?.historicalTrend, 'DEGRADING');
});

test('regressão de performance com aumento de latência p95 > 10% produz PERFORMANCE DEGRADING', () => {
  const s1 = baseSnapshot({ timestamp: '2026-09-01T12:00:00.000Z', apiP95: 100 });
  const s2 = baseSnapshot({ timestamp: '2026-09-02T12:00:00.000Z', apiP95: 105 });
  const s3 = baseSnapshot({
    timestamp: '2026-09-03T12:00:00.000Z',
    apiP95: 125, // +25%, acima da tolerância de 10%
    regressionStatus: 'RED',
  });

  const result = calculateHistoricalTrends([s1, s2, s3]);
  const perf = result.dimensions.find((d) => d.dimension === 'PERFORMANCE');
  assert.equal(perf?.historicalTrend, 'DEGRADING');
  assert.ok(perf?.interpretation.includes('regrediu'));

  const regression = result.dimensions.find((d) => d.dimension === 'REGRESSION');
  assert.equal(regression?.historicalTrend, 'DEGRADING');
});

test('aumento de findings de segurança CRITICAL ou HIGH torna SECURITY DEGRADING', () => {
  const s1 = baseSnapshot({
    timestamp: '2026-09-01T12:00:00.000Z',
    securityFindings: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  });
  const s2 = baseSnapshot({
    timestamp: '2026-09-02T12:00:00.000Z',
    securityFindings: { critical: 0, high: 0, medium: 1, low: 0, info: 0 },
  });
  const s3 = baseSnapshot({
    timestamp: '2026-09-03T12:00:00.000Z',
    securityStatus: 'RED',
    securityFindings: { critical: 1, high: 0, medium: 1, low: 0, info: 0 },
  });

  const result = calculateHistoricalTrends([s1, s2, s3]);
  const sec = result.dimensions.find((d) => d.dimension === 'SECURITY');
  assert.equal(sec?.historicalTrend, 'DEGRADING');
  assert.ok(sec?.interpretation.includes('críticos ou altos'));
  assert.equal(result.overallTrend, 'DEGRADING');
});

test('diminuição de lacunas conhecidas (gaps) produz KNOWN_GAPS IMPROVING', () => {
  const s1 = baseSnapshot({
    timestamp: '2026-09-01T12:00:00.000Z',
    knownGaps: ['Gap 1', 'Gap 2', 'Gap 3'],
  });
  const s2 = baseSnapshot({
    timestamp: '2026-09-02T12:00:00.000Z',
    knownGaps: ['Gap 1', 'Gap 2'],
  });
  const s3 = baseSnapshot({
    timestamp: '2026-09-03T12:00:00.000Z',
    knownGaps: ['Gap 1'],
  });

  const result = calculateHistoricalTrends([s1, s2, s3]);
  const gaps = result.dimensions.find((d) => d.dimension === 'KNOWN_GAPS');
  assert.equal(gaps?.historicalTrend, 'IMPROVING');
  assert.ok(gaps?.interpretation.includes('reduzidas'));
});

test('schema inválido de snapshot é rejeitado pelo validador Zod', () => {
  const invalid = {
    timestamp: 'data-invalida',
    commitSha: '',
    overallStatus: 'SUPER_GREEN',
  };
  assert.throws(() => parseHistorySnapshot(invalid));
});

test('captureHistorySnapshot gera snapshot válido com schema Zod e salva em diretório temporário', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qe-hist-snap-'));
  try {
    const snapshot = captureHistorySnapshot(undefined, {
      repositoryRoot: process.cwd(),
      timestamp: '2026-09-09T22:00:00.000Z',
      commitSha: 'test-sha-1234',
    });

    assert.equal(parseHistorySnapshot(snapshot).commitSha, 'test-sha-1234');
    const savedPath = writeSnapshotFile(snapshot, tempDir);
    assert.ok(fs.existsSync(savedPath));
    const content = JSON.parse(fs.readFileSync(savedPath, 'utf8'));
    assert.equal(content.commitSha, 'test-sha-1234');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('buildHistoryAndTrends consolida snapshots e gera history.json e trends.json válidos', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qe-hist-build-'));
  const snapshotsDir = path.join(tempDir, 'evidence', 'history', 'snapshots');
  fs.mkdirSync(snapshotsDir, { recursive: true });

  try {
    const s1 = baseSnapshot({ timestamp: '2026-09-01T12:00:00.000Z' });
    const s2 = baseSnapshot({ timestamp: '2026-09-02T12:00:00.000Z' });
    const s3 = baseSnapshot({ timestamp: '2026-09-03T12:00:00.000Z' });

    fs.writeFileSync(path.join(snapshotsDir, 's1.json'), JSON.stringify(s1));
    fs.writeFileSync(path.join(snapshotsDir, 's2.json'), JSON.stringify(s2));
    fs.writeFileSync(path.join(snapshotsDir, 's3.json'), JSON.stringify(s3));

    const result = buildHistoryAndTrends({ repositoryRoot: tempDir });
    assert.equal(result.history.totalSnapshots, 3);
    assert.equal(result.trends.canCalculateTrend, true);
    assert.equal(result.trends.overallTrend, 'STABLE');

    assert.ok(fs.existsSync(result.historyFilePath));
    assert.ok(fs.existsSync(result.trendsFilePath));

    const readHist = parseHistoryFile(JSON.parse(fs.readFileSync(result.historyFilePath, 'utf8')));
    const readTrends = parseTrendsFile(JSON.parse(fs.readFileSync(result.trendsFilePath, 'utf8')));
    assert.equal(readHist.totalSnapshots, 3);
    assert.equal(readTrends.checkpointsAnalyzed, 3);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
