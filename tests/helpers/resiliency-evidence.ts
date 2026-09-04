import fs from 'node:fs';
import path from 'node:path';

export interface ResiliencyEvidence {
  scenario: string;
  riskId: string;
  controlId: string;
  startedAt: string;
  recoveredAt: string;
  durationMs: number;
  observedFailure: string;
  finalState: Record<string, unknown>;
  result: 'PASSED' | 'FAILED';
}

export function recordResiliencyEvidence(evidence: ResiliencyEvidence): void {
  const outputDir = path.resolve(process.cwd(), 'evidence', 'resiliency');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  const filePath = path.join(outputDir, `${evidence.scenario}.json`);
  fs.writeFileSync(filePath, JSON.stringify(evidence, null, 2), 'utf8');
}
