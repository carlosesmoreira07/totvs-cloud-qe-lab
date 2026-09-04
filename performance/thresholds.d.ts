/**
 * [LAB] Tipagem TypeScript para thresholds de performance.
 */

export interface PerformanceThresholds {
  maxErrorRate: number;
  maxP95Ms: number;
  maxP99Ms: number;
  maxE2eP95Ms: number;
  maxDuplicateResources: number;
  maxDuplicateOperations: number;
  regressionTolerancePct: number;
}

export declare const LAB_PERFORMANCE_THRESHOLDS: PerformanceThresholds;

export declare const K6_API_THRESHOLDS: {
  http_req_failed: string[];
  http_req_duration: string[];
};

export declare const K6_JOURNEY_THRESHOLDS: {
  http_req_failed: string[];
  http_req_duration: string[];
  e2e_duration: string[];
};
