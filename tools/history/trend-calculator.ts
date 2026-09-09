import type { QualityStatus, QualityTrend } from '../scorecard/scorecard-schema.js';
import type {
  ComparisonStatus,
  DimensionKey,
  DimensionTrendEvaluation,
  HistorySnapshot,
  TrendsFile,
} from './history-schema.js';

const DIMENSION_LABELS: Record<DimensionKey, string> = {
  OVERALL_QUALITY: 'Qualidade Geral',
  RISK_COVERAGE: 'Cobertura de Riscos',
  CONTROLS: 'Controles',
  CRITICAL_JOURNEYS: 'Jornadas Críticas',
  RESILIENCE: 'Resiliência',
  OBSERVABILITY: 'Observabilidade',
  PERFORMANCE: 'Desempenho',
  REGRESSION: 'Regressão',
  SECURITY: 'Segurança',
  KNOWN_GAPS: 'Lacunas Conhecidas',
};

const ORDERED_DIMENSIONS: DimensionKey[] = [
  'OVERALL_QUALITY',
  'RISK_COVERAGE',
  'CONTROLS',
  'CRITICAL_JOURNEYS',
  'RESILIENCE',
  'OBSERVABILITY',
  'PERFORMANCE',
  'REGRESSION',
  'SECURITY',
  'KNOWN_GAPS',
];

export interface TrendCalculationOptions {
  generatedAt?: string;
}

function totalSecurityFindings(snapshot: HistorySnapshot): number {
  const f = snapshot.securityFindings;
  return f.critical + f.high + f.medium + f.low + f.info;
}

function calculateDimensionComparison(
  prev: HistorySnapshot,
  curr: HistorySnapshot,
  dimension: DimensionKey,
): ComparisonStatus {
  switch (dimension) {
    case 'RISK_COVERAGE': {
      const delta = curr.riskCoverage.coveragePct - prev.riskCoverage.coveragePct;
      if (delta > 0.5) return 'IMPROVED';
      if (delta < -0.5) return 'REGRESSED';
      return 'STABLE';
    }
    case 'CONTROLS': {
      if (curr.controlsFailed > prev.controlsFailed || curr.controlsFailed > 0) return 'REGRESSED';
      if (prev.controlsFailed > 0 && curr.controlsFailed === 0) return 'IMPROVED';
      if (curr.controlsPassed > prev.controlsPassed) return 'IMPROVED';
      return 'STABLE';
    }
    case 'CRITICAL_JOURNEYS': {
      if (curr.journeysFailed > prev.journeysFailed || curr.slaBreached > prev.slaBreached) return 'REGRESSED';
      if ((prev.journeysFailed > 0 && curr.journeysFailed === 0) || (prev.slaBreached > 0 && curr.slaBreached === 0)) return 'IMPROVED';
      return 'STABLE';
    }
    case 'RESILIENCE': {
      if (curr.resilienceFailed > prev.resilienceFailed || curr.resilienceFailed > 0) return 'REGRESSED';
      if (prev.resilienceFailed > 0 && curr.resilienceFailed === 0) return 'IMPROVED';
      if (prev.recoveryDuration.avgMs > 0) {
        const delta = (curr.recoveryDuration.avgMs - prev.recoveryDuration.avgMs) / prev.recoveryDuration.avgMs;
        if (delta > 0.15) return 'REGRESSED';
        if (delta < -0.15) return 'IMPROVED';
      }
      return 'STABLE';
    }
    case 'OBSERVABILITY': {
      if (curr.observabilityStatus === 'RED' && prev.observabilityStatus !== 'RED') return 'REGRESSED';
      if (prev.observabilityStatus !== 'GREEN' && curr.observabilityStatus === 'GREEN') return 'IMPROVED';
      return 'STABLE';
    }
    case 'PERFORMANCE': {
      if (curr.performanceStatus === 'RED' && prev.performanceStatus !== 'RED') return 'REGRESSED';
      if (prev.apiP95 !== null && curr.apiP95 !== null && prev.apiP95 > 0) {
        const delta = (curr.apiP95 - prev.apiP95) / prev.apiP95;
        if (delta > 0.10) return 'REGRESSED';
        if (delta < -0.10) return 'IMPROVED';
      }
      return 'STABLE';
    }
    case 'REGRESSION': {
      if (curr.regressionStatus === 'RED' && prev.regressionStatus !== 'RED') return 'REGRESSED';
      if (prev.regressionStatus === 'RED' && curr.regressionStatus === 'GREEN') return 'IMPROVED';
      return 'STABLE';
    }
    case 'SECURITY': {
      const prevCritHigh = prev.securityFindings.critical + prev.securityFindings.high;
      const currCritHigh = curr.securityFindings.critical + curr.securityFindings.high;
      if (currCritHigh > prevCritHigh || currCritHigh > 0) return 'REGRESSED';
      const prevTotal = totalSecurityFindings(prev);
      const currTotal = totalSecurityFindings(curr);
      if (currTotal < prevTotal) return 'IMPROVED';
      if (currTotal > prevTotal) return 'REGRESSED';
      return 'STABLE';
    }
    case 'KNOWN_GAPS': {
      const delta = curr.knownGaps.length - prev.knownGaps.length;
      if (delta < 0) return 'IMPROVED';
      if (delta > 0) return 'REGRESSED';
      return 'STABLE';
    }
    case 'OVERALL_QUALITY': {
      if (curr.overallStatus === 'RED' && prev.overallStatus !== 'RED') return 'REGRESSED';
      if (prev.overallStatus === 'RED' && curr.overallStatus !== 'RED') return 'IMPROVED';
      if (prev.overallStatus === 'YELLOW' && curr.overallStatus === 'GREEN') return 'IMPROVED';
      if (prev.overallStatus === 'GREEN' && curr.overallStatus === 'YELLOW') return 'REGRESSED';
      return 'STABLE';
    }
  }
}

function extractDataPoints(snapshots: HistorySnapshot[], dimension: DimensionKey): Array<number | null> {
  switch (dimension) {
    case 'OVERALL_QUALITY':
    case 'RISK_COVERAGE':
      return snapshots.map((s) => s.riskCoverage.coveragePct);
    case 'CONTROLS':
      return snapshots.map((s) => s.controlsPassed);
    case 'CRITICAL_JOURNEYS':
      return snapshots.map((s) => s.journeysPassed);
    case 'RESILIENCE':
      return snapshots.map((s) => s.recoveryDuration.avgMs);
    case 'OBSERVABILITY':
      return snapshots.map((s) => (s.observabilityStatus === 'GREEN' ? 100 : s.observabilityStatus === 'YELLOW' ? 50 : 0));
    case 'PERFORMANCE':
      return snapshots.map((s) => s.apiP95);
    case 'REGRESSION':
      return snapshots.map((s) => (s.regressionStatus === 'GREEN' ? 100 : s.regressionStatus === 'RED' ? 0 : 50));
    case 'SECURITY':
      return snapshots.map(totalSecurityFindings);
    case 'KNOWN_GAPS':
      return snapshots.map((s) => s.knownGaps.length);
  }
}

export function calculateHistoricalTrends(
  snapshots: HistorySnapshot[],
  options: TrendCalculationOptions = {},
): TrendsFile {
  const sorted = [...snapshots].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const count = sorted.length;
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  if (count === 0) {
    return {
      schemaVersion: '1.0.0',
      generatedAt,
      checkpointsAnalyzed: 0,
      canCalculateTrend: false,
      comparisonStatus: 'UNKNOWN',
      overallTrend: 'UNKNOWN',
      dimensions: ORDERED_DIMENSIONS.map((dim) => ({
        dimension: dim,
        label: DIMENSION_LABELS[dim],
        historicalTrend: 'UNKNOWN',
        comparisonStatus: 'UNKNOWN',
        latestStatus: 'UNKNOWN',
        interpretation: 'Nenhum checkpoint histórico registrado.',
        dataPoints: [],
      })),
      disclaimer: 'Histórico insuficiente: 0 checkpoints disponíveis. São necessários pelo menos 3 para cálculo de tendência.',
    };
  }

  const latest = sorted[count - 1]!;
  const prev = count >= 2 ? sorted[count - 2]! : null;
  const first = sorted[0]!;

  const overallComparison: ComparisonStatus = prev
    ? calculateDimensionComparison(prev, latest, 'OVERALL_QUALITY')
    : 'NO_PREVIOUS_CHECKPOINT';

  if (count < 3) {
    return {
      schemaVersion: '1.0.0',
      generatedAt,
      checkpointsAnalyzed: count,
      canCalculateTrend: false,
      comparisonStatus: overallComparison,
      overallTrend: 'UNKNOWN',
      dimensions: ORDERED_DIMENSIONS.map((dim) => {
        const comp = prev ? calculateDimensionComparison(prev, latest, dim) : 'NO_PREVIOUS_CHECKPOINT';
        const latestStatus: QualityStatus = dim === 'OVERALL_QUALITY'
          ? latest.overallStatus
          : dim === 'RISK_COVERAGE'
            ? (latest.riskCoverage.coveragePct >= 80 ? 'GREEN' : latest.riskCoverage.coveragePct >= 50 ? 'YELLOW' : 'RED')
            : dim === 'CONTROLS'
              ? (latest.controlsFailed > 0 ? 'RED' : 'GREEN')
              : dim === 'CRITICAL_JOURNEYS'
                ? (latest.journeysFailed > 0 || latest.slaBreached > 0 ? 'RED' : 'GREEN')
                : dim === 'RESILIENCE'
                  ? (latest.resilienceFailed > 0 ? 'RED' : 'GREEN')
                  : dim === 'OBSERVABILITY'
                    ? latest.observabilityStatus
                    : dim === 'PERFORMANCE'
                      ? latest.performanceStatus
                      : dim === 'REGRESSION'
                        ? latest.regressionStatus
                        : dim === 'SECURITY'
                          ? latest.securityStatus
                          : (latest.knownGaps.length > 0 ? 'YELLOW' : 'GREEN');
        return {
          dimension: dim,
          label: DIMENSION_LABELS[dim],
          historicalTrend: 'UNKNOWN',
          comparisonStatus: comp,
          latestStatus,
          interpretation: `Histórico insuficiente (${count} de 3 checkpoints mínimos para tendência determinística).`,
          dataPoints: extractDataPoints(sorted, dim),
        };
      }),
      disclaimer: `Histórico insuficiente: ${count} checkpoint(s) disponível(is). Mínimo de 3 checkpoints para cálculo de tendência histórica.`,
    };
  }

  // count >= 3: calculate deterministic historical trends
  const dimensionEvaluations: DimensionTrendEvaluation[] = [];

  // 1. RISK_COVERAGE
  {
    const delta = latest.riskCoverage.coveragePct - first.riskCoverage.coveragePct;
    const prevDelta = prev ? latest.riskCoverage.coveragePct - prev.riskCoverage.coveragePct : 0;
    let trend: QualityTrend = 'STABLE';
    let interpretation = `Cobertura estável em ${latest.riskCoverage.coveragePct}%.`;
    if (prevDelta < -1.0 || delta < -1.0) {
      trend = 'DEGRADING';
      interpretation = `Cobertura de riscos reduziu de ${first.riskCoverage.coveragePct}% para ${latest.riskCoverage.coveragePct}%.`;
    } else if (delta > 1.0 && prevDelta >= 0) {
      trend = 'IMPROVING';
      interpretation = `Cobertura de riscos aumentou de ${first.riskCoverage.coveragePct}% para ${latest.riskCoverage.coveragePct}%.`;
    }
    const comp = prev ? calculateDimensionComparison(prev, latest, 'RISK_COVERAGE') : 'NO_PREVIOUS_CHECKPOINT';
    const status: QualityStatus = latest.riskCoverage.coveragePct >= 80 ? 'GREEN' : latest.riskCoverage.coveragePct >= 50 ? 'YELLOW' : 'RED';
    dimensionEvaluations.push({
      dimension: 'RISK_COVERAGE',
      label: DIMENSION_LABELS.RISK_COVERAGE,
      historicalTrend: trend,
      comparisonStatus: comp,
      latestStatus: status,
      interpretation,
      dataPoints: extractDataPoints(sorted, 'RISK_COVERAGE'),
    });
  }

  // 2. CONTROLS
  {
    let trend: QualityTrend = 'STABLE';
    let interpretation = `${latest.controlsPassed} controles aprovados e ${latest.controlsFailed} falhos mantidos estáveis.`;
    if (latest.controlsFailed > 0 || (prev && latest.controlsFailed > prev.controlsFailed)) {
      trend = 'DEGRADING';
      interpretation = `${latest.controlsFailed} controle(s) falharam na coleta recente.`;
    } else if (first.controlsFailed > 0 && latest.controlsFailed === 0) {
      trend = 'IMPROVING';
      interpretation = `Controles com falha foram eliminados (${first.controlsFailed} -> 0).`;
    } else if (latest.controlsPassed > first.controlsPassed && latest.controlsFailed === 0) {
      trend = 'IMPROVING';
      interpretation = `Mais controles foram implementados e aprovados (${first.controlsPassed} -> ${latest.controlsPassed}) sem falhas.`;
    }
    const comp = prev ? calculateDimensionComparison(prev, latest, 'CONTROLS') : 'NO_PREVIOUS_CHECKPOINT';
    const status: QualityStatus = latest.controlsFailed > 0 ? 'RED' : 'GREEN';
    dimensionEvaluations.push({
      dimension: 'CONTROLS',
      label: DIMENSION_LABELS.CONTROLS,
      historicalTrend: trend,
      comparisonStatus: comp,
      latestStatus: status,
      interpretation,
      dataPoints: extractDataPoints(sorted, 'CONTROLS'),
    });
  }

  // 3. CRITICAL_JOURNEYS
  {
    let trend: QualityTrend = 'STABLE';
    let interpretation = `Jornadas mantidas com ${latest.journeysPassed} aprovadas e zero violações de SLA.`;
    if (latest.journeysFailed > 0 || latest.slaBreached > 0) {
      trend = 'DEGRADING';
      interpretation = `${latest.journeysFailed} jornada(s) falha(s) e ${latest.slaBreached} SLA(s) violado(s).`;
    } else if ((first.journeysFailed > 0 || first.slaBreached > 0) && latest.journeysFailed === 0 && latest.slaBreached === 0) {
      trend = 'IMPROVING';
      interpretation = `Falhas e violações de SLA foram resolvidas nas jornadas ponta a ponta.`;
    }
    const comp = prev ? calculateDimensionComparison(prev, latest, 'CRITICAL_JOURNEYS') : 'NO_PREVIOUS_CHECKPOINT';
    const status: QualityStatus = latest.journeysFailed > 0 || latest.slaBreached > 0 ? 'RED' : 'GREEN';
    dimensionEvaluations.push({
      dimension: 'CRITICAL_JOURNEYS',
      label: DIMENSION_LABELS.CRITICAL_JOURNEYS,
      historicalTrend: trend,
      comparisonStatus: comp,
      latestStatus: status,
      interpretation,
      dataPoints: extractDataPoints(sorted, 'CRITICAL_JOURNEYS'),
    });
  }

  // 4. RESILIENCE
  {
    let trend: QualityTrend = 'STABLE';
    let interpretation = `Recuperação distribuída estável (média ${latest.recoveryDuration.avgMs} ms).`;
    if (latest.resilienceFailed > 0) {
      trend = 'DEGRADING';
      interpretation = `${latest.resilienceFailed} cenário(s) de resiliência falhou(aram).`;
    } else if (first.resilienceFailed > 0 && latest.resilienceFailed === 0) {
      trend = 'IMPROVING';
      interpretation = `Cenários de resiliência recuperados com sucesso (falhas eliminadas).`;
    } else if (first.recoveryDuration.avgMs > 0) {
      const delta = (latest.recoveryDuration.avgMs - first.recoveryDuration.avgMs) / first.recoveryDuration.avgMs;
      if (delta > 0.15) {
        trend = 'DEGRADING';
        interpretation = `Tempo médio de recuperação degradou ${Math.round(delta * 100)}% (${first.recoveryDuration.avgMs} -> ${latest.recoveryDuration.avgMs} ms).`;
      } else if (delta < -0.15) {
        trend = 'IMPROVING';
        interpretation = `Tempo médio de recuperação melhorou ${Math.round(Math.abs(delta) * 100)}% (${first.recoveryDuration.avgMs} -> ${latest.recoveryDuration.avgMs} ms).`;
      }
    }
    const comp = prev ? calculateDimensionComparison(prev, latest, 'RESILIENCE') : 'NO_PREVIOUS_CHECKPOINT';
    const status: QualityStatus = latest.resilienceFailed > 0 ? 'RED' : 'GREEN';
    dimensionEvaluations.push({
      dimension: 'RESILIENCE',
      label: DIMENSION_LABELS.RESILIENCE,
      historicalTrend: trend,
      comparisonStatus: comp,
      latestStatus: status,
      interpretation,
      dataPoints: extractDataPoints(sorted, 'RESILIENCE'),
    });
  }

  // 5. OBSERVABILITY
  {
    let trend: QualityTrend = 'STABLE';
    let interpretation = `Observabilidade e rastreabilidade estáveis em ${latest.observabilityStatus}.`;
    if (latest.observabilityStatus === 'RED') {
      trend = 'DEGRADING';
      interpretation = 'Falhas determinísticas em controles de observabilidade.';
    } else if (first.observabilityStatus === 'RED') {
      trend = 'IMPROVING';
      interpretation = 'Rastreabilidade e métricas de observabilidade recuperadas.';
    } else if (first.observabilityStatus === 'YELLOW' && latest.observabilityStatus === 'GREEN') {
      trend = 'IMPROVING';
      interpretation = 'Cadeias completas de rastreamento restabelecidas.';
    } else if (first.observabilityStatus === 'GREEN' && latest.observabilityStatus === 'YELLOW') {
      trend = 'DEGRADING';
      interpretation = 'Cadeias parciais de rastreamento detectadas.';
    }
    const comp = prev ? calculateDimensionComparison(prev, latest, 'OBSERVABILITY') : 'NO_PREVIOUS_CHECKPOINT';
    dimensionEvaluations.push({
      dimension: 'OBSERVABILITY',
      label: DIMENSION_LABELS.OBSERVABILITY,
      historicalTrend: trend,
      comparisonStatus: comp,
      latestStatus: latest.observabilityStatus,
      interpretation,
      dataPoints: extractDataPoints(sorted, 'OBSERVABILITY'),
    });
  }

  // 6. PERFORMANCE
  {
    let trend: QualityTrend = 'STABLE';
    let interpretation = `Desempenho com p95 de ${latest.apiP95 ?? 'N/D'} ms dentro das tolerâncias sintéticas.`;
    if (latest.performanceStatus === 'RED') {
      trend = 'DEGRADING';
      interpretation = 'Limites sintéticos de desempenho violados.';
    } else if (first.apiP95 !== null && latest.apiP95 !== null && first.apiP95 > 0) {
      const delta = (latest.apiP95 - first.apiP95) / first.apiP95;
      if (delta > 0.10) {
        trend = 'DEGRADING';
        interpretation = `Latência p95 regrediu ${Math.round(delta * 100)}% (${first.apiP95} -> ${latest.apiP95} ms), acima da tolerância de 10%.`;
      } else if (delta < -0.10) {
        trend = 'IMPROVING';
        interpretation = `Latência p95 melhorou ${Math.round(Math.abs(delta) * 100)}% (${first.apiP95} -> ${latest.apiP95} ms).`;
      }
    }
    const comp = prev ? calculateDimensionComparison(prev, latest, 'PERFORMANCE') : 'NO_PREVIOUS_CHECKPOINT';
    dimensionEvaluations.push({
      dimension: 'PERFORMANCE',
      label: DIMENSION_LABELS.PERFORMANCE,
      historicalTrend: trend,
      comparisonStatus: comp,
      latestStatus: latest.performanceStatus,
      interpretation,
      dataPoints: extractDataPoints(sorted, 'PERFORMANCE'),
    });
  }

  // 7. REGRESSION
  {
    let trend: QualityTrend = 'STABLE';
    let interpretation = 'Sem regressão observada contra baseline nos checkpoints.';
    if (latest.regressionStatus === 'RED') {
      trend = 'DEGRADING';
      interpretation = 'Regressão de performance detectada contra o baseline de referência.';
    } else if (first.regressionStatus === 'RED' && latest.regressionStatus === 'GREEN') {
      trend = 'IMPROVING';
      interpretation = 'Regressão anterior foi superada e o desempenho normalizado.';
    } else if (latest.regressionStatus === 'UNKNOWN') {
      trend = 'UNKNOWN';
      interpretation = 'Referência de baseline indisponível para avaliação contínua de regressão.';
    }
    const comp = prev ? calculateDimensionComparison(prev, latest, 'REGRESSION') : 'NO_PREVIOUS_CHECKPOINT';
    dimensionEvaluations.push({
      dimension: 'REGRESSION',
      label: DIMENSION_LABELS.REGRESSION,
      historicalTrend: trend,
      comparisonStatus: comp,
      latestStatus: latest.regressionStatus,
      interpretation,
      dataPoints: extractDataPoints(sorted, 'REGRESSION'),
    });
  }

  // 8. SECURITY
  {
    // Localizar o primeiro snapshot que possuía scanners ativos
    const firstInstrumented = sorted.find((s) => s.securityStatus !== 'UNKNOWN') ?? first;
    const firstCritHigh = firstInstrumented.securityFindings.critical + firstInstrumented.securityFindings.high;
    const latestCritHigh = latest.securityFindings.critical + latest.securityFindings.high;
    const firstTotal = totalSecurityFindings(firstInstrumented);
    const latestTotal = totalSecurityFindings(latest);

    let trend: QualityTrend = 'STABLE';
    let interpretation = `Postura de segurança estável com ${latestTotal} finding(s) (zero CRITICAL/HIGH).`;

    if (latestCritHigh > firstCritHigh || latest.securityFindings.critical > 0 || latest.securityFindings.high > 0) {
      trend = 'DEGRADING';
      interpretation = `Findings críticos ou altos em aberto (${latest.securityFindings.critical} critical, ${latest.securityFindings.high} high).`;
    } else if (firstInstrumented !== latest && latestTotal < firstTotal) {
      trend = 'IMPROVING';
      interpretation = `Vulnerabilidades reduzidas de ${firstTotal} para ${latestTotal} findings.`;
    } else if (firstInstrumented !== latest && latestTotal > firstTotal && latestCritHigh > 0) {
      trend = 'DEGRADING';
      interpretation = `Aumento no total de findings com risco relevante (${firstTotal} -> ${latestTotal}).`;
    } else if (firstInstrumented !== latest && latestTotal > firstTotal) {
      // Se aumentou apenas findings de severidade baixa/média
      trend = 'DEGRADING';
      interpretation = `Aumento de findings de severidade média/baixa (${firstTotal} -> ${latestTotal}).`;
    }

    const comp = prev ? calculateDimensionComparison(prev, latest, 'SECURITY') : 'NO_PREVIOUS_CHECKPOINT';
    dimensionEvaluations.push({
      dimension: 'SECURITY',
      label: DIMENSION_LABELS.SECURITY,
      historicalTrend: trend,
      comparisonStatus: comp,
      latestStatus: latest.securityStatus,
      interpretation,
      dataPoints: extractDataPoints(sorted, 'SECURITY'),
    });
  }

  // 9. KNOWN_GAPS
  {
    const delta = latest.knownGaps.length - first.knownGaps.length;
    let trend: QualityTrend = 'STABLE';
    let interpretation = `${latest.knownGaps.length} gaps conhecidos sob monitoramento estável.`;
    if (delta < 0) {
      trend = 'IMPROVING';
      interpretation = `Lacunas de evidência reduzidas (${first.knownGaps.length} -> ${latest.knownGaps.length}).`;
    } else if (delta > 0) {
      trend = 'DEGRADING';
      interpretation = `Novas lacunas identificadas (${first.knownGaps.length} -> ${latest.knownGaps.length}).`;
    }
    const comp = prev ? calculateDimensionComparison(prev, latest, 'KNOWN_GAPS') : 'NO_PREVIOUS_CHECKPOINT';
    const status: QualityStatus = latest.knownGaps.length > 0 ? 'YELLOW' : 'GREEN';
    dimensionEvaluations.push({
      dimension: 'KNOWN_GAPS',
      label: DIMENSION_LABELS.KNOWN_GAPS,
      historicalTrend: trend,
      comparisonStatus: comp,
      latestStatus: status,
      interpretation,
      dataPoints: extractDataPoints(sorted, 'KNOWN_GAPS'),
    });
  }

  // 10. OVERALL_QUALITY
  const criticalDimensions: DimensionKey[] = ['CONTROLS', 'CRITICAL_JOURNEYS', 'PERFORMANCE', 'SECURITY'];
  const hasCriticalDegrading = dimensionEvaluations.some(
    (d) => criticalDimensions.includes(d.dimension) && d.historicalTrend === 'DEGRADING',
  );
  const degradingCount = dimensionEvaluations.filter((d) => d.historicalTrend === 'DEGRADING').length;
  const improvingCount = dimensionEvaluations.filter((d) => d.historicalTrend === 'IMPROVING').length;

  let overallTrend: QualityTrend = 'STABLE';
  let overallInterpretation = 'Qualidade geral estável ao longo dos checkpoints analisados.';
  if (latest.overallStatus === 'RED' || hasCriticalDegrading || (degradingCount > 0 && improvingCount === 0)) {
    overallTrend = 'DEGRADING';
    overallInterpretation = 'Degradação observada em dimensões críticas de qualidade.';
  } else if (improvingCount > degradingCount && !hasCriticalDegrading) {
    overallTrend = 'IMPROVING';
    overallInterpretation = `Evolução positiva consistente (${improvingCount} dimensões em melhoria, sem degradação crítica).`;
  }

  const overallEval: DimensionTrendEvaluation = {
    dimension: 'OVERALL_QUALITY',
    label: DIMENSION_LABELS.OVERALL_QUALITY,
    historicalTrend: overallTrend,
    comparisonStatus: overallComparison,
    latestStatus: latest.overallStatus,
    interpretation: overallInterpretation,
    dataPoints: extractDataPoints(sorted, 'OVERALL_QUALITY'),
  };

  return {
    schemaVersion: '1.0.0',
    generatedAt,
    checkpointsAnalyzed: count,
    canCalculateTrend: true,
    comparisonStatus: overallComparison,
    overallTrend,
    dimensions: [overallEval, ...dimensionEvaluations],
    disclaimer: `Tendência histórica baseada em ${count} checkpoints comparáveis; não utiliza projeção probabilística ou score arbitrário.`,
  };
}
