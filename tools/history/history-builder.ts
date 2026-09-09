import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  historyFileSchema,
  parseHistoryFile,
  parseHistorySnapshot,
  parseTrendsFile,
  trendsFileSchema,
  type HistoryFile,
  type HistorySnapshot,
  type TrendsFile,
} from './history-schema.js';
import { calculateHistoricalTrends } from './trend-calculator.js';

export interface HistoryBuildOptions {
  repositoryRoot?: string;
  generatedAt?: string;
}

export interface HistoryBuildResult {
  history: HistoryFile;
  trends: TrendsFile;
  historyFilePath: string;
  trendsFilePath: string;
}

export function loadSnapshotsFromDirectory(directory: string): HistorySnapshot[] {
  if (!fs.existsSync(directory)) return [];

  const files = fs.readdirSync(directory)
    .filter((file) => file.endsWith('.json') && !file.endsWith('history.json') && !file.endsWith('trends.json'))
    .sort();

  const snapshots: HistorySnapshot[] = [];
  for (const file of files) {
    const fullPath = path.join(directory, file);
    try {
      const raw = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      snapshots.push(parseHistorySnapshot(raw));
    } catch (error) {
      throw new Error(`Arquivo de snapshot inválido em ${fullPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return snapshots.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

export function buildHistoryAndTrends(options: HistoryBuildOptions = {}): HistoryBuildResult {
  const repoRoot = options.repositoryRoot ?? process.cwd();
  const historyDir = path.join(repoRoot, 'evidence', 'history');
  const snapshotsDir = path.join(historyDir, 'snapshots');
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  fs.mkdirSync(historyDir, { recursive: true });

  const snapshots = loadSnapshotsFromDirectory(snapshotsDir);

  const history: HistoryFile = parseHistoryFile({
    schemaVersion: '1.0.0',
    generatedAt,
    totalSnapshots: snapshots.length,
    snapshots,
  });

  const trends: TrendsFile = parseTrendsFile(
    calculateHistoricalTrends(snapshots, { generatedAt }),
  );

  const historyFilePath = path.join(historyDir, 'history.json');
  const trendsFilePath = path.join(historyDir, 'trends.json');

  fs.writeFileSync(historyFilePath, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
  fs.writeFileSync(trendsFilePath, `${JSON.stringify(trends, null, 2)}\n`, 'utf8');

  return {
    history,
    trends,
    historyFilePath,
    trendsFilePath,
  };
}

async function main(): Promise<void> {
  const result = buildHistoryAndTrends();
  const relHistory = path.relative(process.cwd(), result.historyFilePath);
  const relTrends = path.relative(process.cwd(), result.trendsFilePath);
  process.stdout.write(`Histórico consolidado (${result.history.totalSnapshots} snapshots): ${relHistory}, ${relTrends}\n`);
  process.stdout.write(`Tendência geral: ${result.trends.overallTrend} (comparação: ${result.trends.comparisonStatus})\n`);
}

const executedFile = process.argv[1];
if (executedFile && import.meta.url === pathToFileURL(executedFile).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`Falha ao consolidar histórico: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
