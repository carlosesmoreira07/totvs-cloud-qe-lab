/**
 * [LAB] Comparador determinístico de performance contra baseline.
 * Não utiliza IA para realizar cálculos aritméticos.
 */

export interface PerformanceMetrics {
  totalRequests: number;
  requestsPerSecond: number;
  successRate: number;
  errorRate: number;
  p50: number;
  p95: number;
  p99: number;
  maxLatency: number;
  e2eP50?: number | undefined;
  e2eP95?: number | undefined;
  duplicateResources: number;
  duplicateOperations: number;
}

export interface MetricDifference {
  current: number;
  baseline: number;
  diff: number;
  pctChange: number;
  regressed: boolean;
}

export type ComparisonStatus = 'IMPROVED' | 'STABLE' | 'REGRESSED' | 'NO_BASELINE';

export interface BaselineComparisonResult {
  status: ComparisonStatus;
  tolerancePct: number;
  differences: Record<string, MetricDifference>;
  regressedMetrics: string[];
  improvedMetrics: string[];
}

export function comparePerformanceBaseline(
  current: PerformanceMetrics,
  baseline?: PerformanceMetrics | null,
  tolerancePct = 0.20,
): BaselineComparisonResult {
  if (!baseline) {
    return {
      status: 'NO_BASELINE',
      tolerancePct,
      differences: {},
      regressedMetrics: [],
      improvedMetrics: [],
    };
  }

  const differences: Record<string, MetricDifference> = {};
  const regressedMetrics: string[] = [];
  const improvedMetrics: string[] = [];

  const compareHigherIsWorse = (key: keyof PerformanceMetrics, currentVal: number, baselineVal: number) => {
    const diff = Math.round((currentVal - baselineVal) * 100) / 100;
    const pctChange = baselineVal > 0 ? Math.round(((currentVal - baselineVal) / baselineVal) * 1000) / 10 : 0;
    const isRegressed = currentVal > baselineVal * (1 + tolerancePct);
    const isImproved = currentVal < baselineVal * (1 - 0.10);

    differences[key] = {
      current: currentVal,
      baseline: baselineVal,
      diff,
      pctChange,
      regressed: isRegressed,
    };

    if (isRegressed) {
      regressedMetrics.push(key);
    } else if (isImproved) {
      improvedMetrics.push(key);
    }
  };

  const compareHigherIsBetter = (key: keyof PerformanceMetrics, currentVal: number, baselineVal: number) => {
    const diff = Math.round((currentVal - baselineVal) * 100) / 100;
    const pctChange = baselineVal > 0 ? Math.round(((currentVal - baselineVal) / baselineVal) * 1000) / 10 : 0;
    const isRegressed = currentVal < baselineVal * (1 - tolerancePct);
    const isImproved = currentVal > baselineVal * (1 + 0.10);

    differences[key] = {
      current: currentVal,
      baseline: baselineVal,
      diff,
      pctChange,
      regressed: isRegressed,
    };

    if (isRegressed) {
      regressedMetrics.push(key);
    } else if (isImproved) {
      improvedMetrics.push(key);
    }
  };

  compareHigherIsWorse('p95', current.p95, baseline.p95);
  compareHigherIsWorse('p99', current.p99, baseline.p99);
  compareHigherIsWorse('errorRate', current.errorRate, baseline.errorRate);
  compareHigherIsBetter('requestsPerSecond', current.requestsPerSecond, baseline.requestsPerSecond);

  if (current.e2eP95 !== undefined && baseline.e2eP95 !== undefined && baseline.e2eP95 > 0) {
    compareHigherIsWorse('e2eP95', current.e2eP95, baseline.e2eP95);
  }

  // Duplicados: qualquer valor > 0 é regressão inaceitável
  if (current.duplicateResources > 0 || current.duplicateOperations > 0) {
    regressedMetrics.push('duplicates');
  }

  let status: ComparisonStatus = 'STABLE';
  if (regressedMetrics.length > 0) {
    status = 'REGRESSED';
  } else if (improvedMetrics.length > 0) {
    status = 'IMPROVED';
  }

  return {
    status,
    tolerancePct,
    differences,
    regressedMetrics,
    improvedMetrics,
  };
}
