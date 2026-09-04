import fs from 'node:fs';
import path from 'node:path';

export interface ObservabilityEvidence {
  scenario: string;
  riskId: string;
  controlId: string;
  traceId: string;
  correlationId: string;
  spansObserved: Array<{
    name: string;
    spanId: string;
    parentSpanId?: string | undefined;
    status: string;
    attributes: Record<string, unknown>;
  }>;
  metricsObserved: Record<string, number>;
  observedIssue?: string | undefined;
  finalState: Record<string, unknown>;
  result: 'PASSED' | 'FAILED';
}

export function recordObservabilityEvidence(evidence: ObservabilityEvidence): void {
  const outputDir = path.resolve(process.cwd(), 'evidence', 'observability');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  const filePath = path.join(outputDir, `${evidence.scenario}.json`);
  fs.writeFileSync(filePath, JSON.stringify(evidence, null, 2), 'utf8');
}
