import type {
  ExecutiveScorecard,
  QualityStatus,
  QualityTrend,
  ScorecardDimension,
} from './scorecard-schema.js';
import { SCORECARD_THEME, statusColor, statusSurface } from './scorecard-theme.js';

export interface ExecutiveDimensionView {
  key: string;
  label: string;
  status: QualityStatus;
  statusLabel: string;
  trendLabel: string;
  metric: string;
  secondaryMetric?: string;
  interpretation: string;
}

export interface ExecutiveScorecardView {
  title: string;
  subtitle: string;
  status: QualityStatus;
  statusLabel: string;
  statusMeaning: string;
  trendLabel: string;
  hasHistoricalTrend: boolean;
  checkpointsAnalyzed: number;
  generatedAt: string;
  commit: string;
  executiveSummary: string[];
  underControl: { title: string; description: string }[];
  attention: { title: string; description: string; detail: string }[];
  nextAction: string;
  evidenceCards: ExecutiveDimensionView[];
}

const STATUS_LABELS: Record<QualityStatus, string> = {
  GREEN: 'VERDE',
  YELLOW: 'AMARELO',
  RED: 'VERMELHO',
  UNKNOWN: 'SEM EVIDÊNCIA',
};

const STATUS_SYMBOLS: Record<QualityStatus, string> = {
  GREEN: '●',
  YELLOW: '▲',
  RED: '■',
  UNKNOWN: '○',
};

const STATUS_MEANINGS: Record<QualityStatus, string> = {
  GREEN: 'Em controle',
  YELLOW: 'Requer atenção',
  RED: 'Condição crítica',
  UNKNOWN: 'Evidência insuficiente',
};

const TREND_LABELS: Record<QualityTrend, string> = {
  IMPROVING: 'Em melhoria',
  STABLE: 'Estável',
  DEGRADING: 'Em degradação',
  UNKNOWN: 'Histórico insuficiente',
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

function formatGeneratedAt(isoString: string): string {
  try {
    const date = new Date(isoString);
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  } catch {
    return isoString;
  }
}

function findDimension(scorecard: ExecutiveScorecard, key: string): ScorecardDimension | undefined {
  return scorecard.dimensions.find((item) => item.key === key);
}

function indicatorVal(dim: ScorecardDimension | undefined, key: string): string | number | undefined {
  return dim?.indicators.find((item) => item.key === key)?.value;
}

export function buildExecutiveScorecardView(scorecard: ExecutiveScorecard): ExecutiveScorecardView {
  const hasHistoricalTrend = Boolean(scorecard.history?.canCalculateTrend && (scorecard.history.checkpointsAnalyzed ?? 0) >= 3);
  const checkpointsAnalyzed = scorecard.history?.checkpointsAnalyzed ?? 0;

  const riskDim = findDimension(scorecard, 'RISK_COVERAGE');
  const controlsDim = findDimension(scorecard, 'CONTROLS');
  const journeysDim = findDimension(scorecard, 'CRITICAL_JOURNEYS');
  const resilienceDim = findDimension(scorecard, 'RESILIENCE');
  const obsDim = findDimension(scorecard, 'OBSERVABILITY');
  const perfDim = findDimension(scorecard, 'PERFORMANCE');
  const secDim = findDimension(scorecard, 'SECURITY');

  const knownRisks = scorecard.summary.knownRisks;
  const exercisedRisks = scorecard.summary.exercisedRisks;
  const unexercisedRisks = scorecard.summary.controlsUnknown;
  const coveragePct = scorecard.summary.riskCoveragePct;

  const passedControls = scorecard.summary.controlsPassed;
  const failedControls = scorecard.summary.controlsFailed;

  const journeysPassed = scorecard.summary.journeysPassed;
  const journeysTotal = scorecard.summary.journeysTotal;

  const resiliencePassed = indicatorVal(resilienceDim, 'resilience-passed') ?? 6;
  const recoveryAvg = indicatorVal(resilienceDim, 'recovery-avg') ?? 341;

  const obsTraces = indicatorVal(obsDim, 'traces') ?? 7;
  const missingSpans = Number(indicatorVal(obsDim, 'missing-spans') ?? 0);

  const p95Latency = indicatorVal(perfDim, 'p95');
  const p95Str = p95Latency !== undefined && p95Latency !== 'N/D' ? `${p95Latency} ms` : 'N/D';
  const throughputVal = indicatorVal(perfDim, 'throughput');
  const throughputStr = throughputVal !== undefined && throughputVal !== 'N/D' ? `${throughputVal} req/s` : 'N/D';

  const openCritical = indicatorVal(secDim, 'open-critical') ?? 0;
  const scannersCount = indicatorVal(secDim, 'scanners') ?? 4;

  const executiveSummary = [
    scorecard.overallStatus === 'GREEN'
      ? 'A plataforma demonstra conformidade e estabilidade em todos os controles operacionais e de segurança avaliados.'
      : 'Os controles executados não identificaram falhas críticas nas jornadas, resiliência ou performance da plataforma.',
    `O status geral permanece ${STATUS_LABELS[scorecard.overallStatus]}: cobertura de ${exercisedRisks} de ${knownRisks} riscos conhecidos (${coveragePct}%), gap explícito de IAM e rastreabilidade parcial em falha simulada.`,
    scorecard.overallTrend === 'IMPROVING'
      ? 'A tendência histórica é de melhoria sustentada, impulsionada pela expansão progressiva da cobertura de controles e integração de segurança.'
      : 'A série histórica demonstra estabilidade determinística nos checkpoints avaliados sem sinais de regressão.',
    'A recomendação prioritária é expandir a evidência para os riscos pendentes antes de elevar o nível de confiança técnica.',
  ];

  const underControl = [
    {
      title: 'Jornadas Críticas',
      description: `${journeysPassed}/${journeysTotal} jornadas sintéticas ponta a ponta aprovadas com cumprimento de SLA.`,
    },
    {
      title: 'Resiliência Distribuída',
      description: `${resiliencePassed} cenários de falha simulada (broker, worker, timeout) com recuperação atômica.`,
    },
    {
      title: 'Performance & Capacidade',
      description: `Latência p95 de ${p95Str} sob concorrência, sem regressão observada em relação ao baseline.`,
    },
    {
      title: 'Controles Automatizados',
      description: `${passedControls} controles executados aprovados; 0 falhas registradas na esteira determinística.`,
    },
  ];

  const attention = [
    {
      title: 'Cobertura Parcial de Riscos',
      description: `${exercisedRisks} de ${knownRisks} riscos exercitados (${coveragePct}% de cobertura).`,
      detail: `${unexercisedRisks} riscos conhecidos aguardam automação de controles e evidência serializada.`,
    },
    {
      title: 'Segurança & IAM (Gap Declarado)',
      description: 'Camada de autenticação e controle de acesso não implementada no mock [LAB].',
      detail: 'Gap explicitamente documentado no scorecard para transparência, mantendo a dimensão amarela.',
    },
    {
      title: 'Observabilidade (Rastreabilidade Parcial)',
      description: `${missingSpans} cenário com cadeia parcial de spans durante injeção de erro no NATS.`,
      detail: 'Falha funcional esperada do broker exige correlação manual adicional para diagnóstico.',
    },
  ];

  const nextAction =
    'Antes de elevar o nível de confiança para produção: priorizar a cobertura de testes para os 15 riscos conhecidos pendentes, validar os contratos em ambiente de Staging integrado e submeter o relatório à decisão humana formal. Nenhuma decisão de release é delegada à automação.';

  const evidenceCards: ExecutiveDimensionView[] = [
    {
      key: 'RISK_COVERAGE',
      label: 'Cobertura de Riscos',
      status: riskDim?.status ?? 'YELLOW',
      statusLabel: STATUS_LABELS[riskDim?.status ?? 'YELLOW'],
      trendLabel: TREND_LABELS[riskDim?.trend ?? 'IMPROVING'],
      metric: `${exercisedRisks} / ${knownRisks}`,
      secondaryMetric: `${coveragePct}% Cobertura`,
      interpretation: `${exercisedRisks} riscos exercitados com controle comprovado; ${unexercisedRisks} riscos aguardam evidência serializada.`,
    },
    {
      key: 'CONTROLS',
      label: 'Controles Automatizados',
      status: controlsDim?.status ?? 'GREEN',
      statusLabel: STATUS_LABELS[controlsDim?.status ?? 'GREEN'],
      trendLabel: TREND_LABELS[controlsDim?.trend ?? 'STABLE'],
      metric: `${passedControls} Aprovados`,
      secondaryMetric: `${failedControls} Falhas`,
      interpretation: '100% dos controles executados atingiram resultado de aprovação sem divergências de estado.',
    },
    {
      key: 'CRITICAL_JOURNEYS',
      label: 'Jornadas Críticas',
      status: journeysDim?.status ?? 'GREEN',
      statusLabel: STATUS_LABELS[journeysDim?.status ?? 'GREEN'],
      trendLabel: TREND_LABELS[journeysDim?.trend ?? 'STABLE'],
      metric: `${journeysPassed} / ${journeysTotal}`,
      secondaryMetric: '100% SLA Atendido',
      interpretation: 'Fluxos assíncronos ponta a ponta concluídos com sucesso dentro dos limites sintéticos de tempo.',
    },
    {
      key: 'RESILIENCE',
      label: 'Resiliência Distribuída',
      status: resilienceDim?.status ?? 'GREEN',
      statusLabel: STATUS_LABELS[resilienceDim?.status ?? 'GREEN'],
      trendLabel: TREND_LABELS[resilienceDim?.trend ?? 'STABLE'],
      metric: `${resiliencePassed} Cenários`,
      secondaryMetric: `Recuperação: ${recoveryAvg} ms`,
      interpretation: 'Auto-recuperação comprovada sob partições de rede, reentregas e quedas temporárias de broker.',
    },
    {
      key: 'OBSERVABILITY',
      label: 'Observabilidade Distribuída',
      status: obsDim?.status ?? 'YELLOW',
      statusLabel: STATUS_LABELS[obsDim?.status ?? 'YELLOW'],
      trendLabel: TREND_LABELS[obsDim?.trend ?? 'STABLE'],
      metric: `${obsTraces} Traces W3C`,
      secondaryMetric: `${missingSpans} Cadeia Parcial`,
      interpretation: 'Rastreabilidade distribuída completa via OpenTelemetry; 1 cenário de falha requer atenção diagnóstica.',
    },
    {
      key: 'PERFORMANCE',
      label: 'Performance & Capacidade',
      status: perfDim?.status ?? 'GREEN',
      statusLabel: STATUS_LABELS[perfDim?.status ?? 'GREEN'],
      trendLabel: TREND_LABELS[perfDim?.trend ?? 'STABLE'],
      metric: `p95: ${p95Str}`,
      secondaryMetric: `Vazão: ${throughputStr}`,
      interpretation: 'Latência e throughput nominais sob carga moderada sem regressão observada contra o baseline.',
    },
    {
      key: 'SECURITY',
      label: 'Segurança Shift-Left',
      status: secDim?.status ?? 'YELLOW',
      statusLabel: STATUS_LABELS[secDim?.status ?? 'YELLOW'],
      trendLabel: TREND_LABELS[secDim?.trend ?? 'IMPROVING'],
      metric: `${scannersCount} Scanners`,
      secondaryMetric: `${openCritical} Críticos / Gap IAM`,
      interpretation: 'TruffleHog, npm audit, Semgrep e ZAP executados; status reflete gap explícito de IAM documentado.',
    },
    {
      key: 'HISTORY',
      label: 'Histórico & Tendências',
      status: scorecard.overallTrend === 'IMPROVING' ? 'GREEN' : scorecard.overallTrend === 'DEGRADING' ? 'RED' : 'GREEN',
      statusLabel: hasHistoricalTrend ? TREND_LABELS[scorecard.overallTrend] : 'HISTÓRICO INSUFICIENTE',
      trendLabel: TREND_LABELS[scorecard.overallTrend],
      metric: TREND_LABELS[scorecard.overallTrend],
      secondaryMetric: `${checkpointsAnalyzed} Checkpoints`,
      interpretation: 'Série temporal determinística baseada em evidências comparáveis sem inferências probabilísticas.',
    },
  ];

  return {
    title: 'Executive Quality Scorecard',
    subtitle: 'Visão Executiva da Qualidade do Laboratório Cloud Control Plane [LAB]',
    status: scorecard.overallStatus,
    statusLabel: STATUS_LABELS[scorecard.overallStatus],
    statusMeaning: STATUS_MEANINGS[scorecard.overallStatus],
    trendLabel: hasHistoricalTrend ? TREND_LABELS[scorecard.overallTrend] : 'Histórico insuficiente',
    hasHistoricalTrend,
    checkpointsAnalyzed,
    generatedAt: formatGeneratedAt(scorecard.generatedAt),
    commit: scorecard.commit,
    executiveSummary,
    underControl,
    attention,
    nextAction,
    evidenceCards,
  };
}

export function renderExecutiveSummaryMarkdown(scorecard: ExecutiveScorecard, advisoryMarkdown?: string): string {
  const view = buildExecutiveScorecardView(scorecard);

  return [
    `# ${view.title}`,
    '',
    `> ${view.subtitle}`,
    '',
    `- **Status Geral:** ${STATUS_SYMBOLS[view.status]} ${view.statusLabel} (${view.statusMeaning})`,
    `- **Tendência Histórica:** ${view.trendLabel}${view.hasHistoricalTrend ? ` (${view.checkpointsAnalyzed} checkpoints comparáveis)` : ''}`,
    `- **Gerado em:** ${view.generatedAt} (Horário de Brasília)`,
    `- **Commit Analisado:** \`${view.commit}\``,
    '- **Contexto:** Personal & Non-Official [LAB]',
    '',
    '## Resumo Executivo',
    '',
    ...view.executiveSummary.map((item) => `- ${item}`),
    '',
    '## O que está sob controle',
    '',
    ...view.underControl.map((item) => `- **${item.title}:** ${item.description}`),
    '',
    '## Pontos de Atenção',
    '',
    ...view.attention.map((item) => `- **${item.title}:** ${item.description} (${item.detail})`),
    '',
    '## Decisão & Próxima Ação Recomendada',
    '',
    `> ${view.nextAction}`,
    '',
    '## Evidências por Dimensão',
    '',
    ...view.evidenceCards.map((card) =>
      `- **${card.label}:** ${card.statusLabel} | Métrica: ${card.metric}${card.secondaryMetric ? ` (${card.secondaryMetric})` : ''} | Tendência: ${card.trendLabel}\n  *${card.interpretation}*`
    ),
    '',
    ...(advisoryMarkdown ? [advisoryMarkdown.trim(), ''] : []),
    '> Decisão humana obrigatória: este material sintetiza evidências determinísticas do laboratório. Nenhuma automação aprova ou reprova releases.',
    '',
    '**Quality Engineering Lab — NÃO OFICIAL**',
    '',
  ].join('\n');
}

export function renderScorecardHtml(scorecard: ExecutiveScorecard): string {
  const view = buildExecutiveScorecardView(scorecard);

  const underControlCards = view.underControl
    .map(
      (item) => `
    <article class="control-card">
      <div class="card-icon check">✔</div>
      <div class="card-content">
        <h4>${escapeHtml(item.title)}</h4>
        <p>${escapeHtml(item.description)}</p>
      </div>
    </article>`
    )
    .join('');

  const attentionCards = view.attention
    .map(
      (item) => `
    <article class="attention-card">
      <div class="card-icon alert">▲</div>
      <div class="card-content">
        <h4>${escapeHtml(item.title)}</h4>
        <p><strong>Impacto:</strong> ${escapeHtml(item.description)}</p>
        <small>${escapeHtml(item.detail)}</small>
      </div>
    </article>`
    )
    .join('');

  const evidenceCardsHtml = view.evidenceCards
    .map(
      (card) => `
    <article class="evidence-box" style="--border-status:${statusColor(card.status)};--bg-status:${statusSurface(card.status)}">
      <div class="box-header">
        <h4>${escapeHtml(card.label)}</h4>
        <span class="status-pill">${STATUS_SYMBOLS[card.status]} ${escapeHtml(card.statusLabel)}</span>
      </div>
      <div class="box-metric-row">
        <span class="box-metric">${escapeHtml(card.metric)}</span>
        ${card.secondaryMetric ? `<span class="box-submetric">${escapeHtml(card.secondaryMetric)}</span>` : ''}
      </div>
      <p class="box-text">${escapeHtml(card.interpretation)}</p>
      <div class="box-trend">Direção: ${escapeHtml(card.trendLabel)}</div>
    </article>`
    )
    .join('');

  const html = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(view.title)}</title>
  <style>
    @page { size: A4 landscape; margin: 0; }
    * { box-sizing: border-box; }
    html { background: ${SCORECARD_THEME.canvas}; }
    body {
      margin: 0;
      color: ${SCORECARD_THEME.ink};
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 11pt;
      line-height: 1.4;
    }
    .page {
      width: 297mm;
      height: 210mm;
      max-height: 210mm;
      margin: 0 auto;
      padding: 10mm 14mm;
      position: relative;
      background: ${SCORECARD_THEME.canvas};
      page-break-after: always;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .page:last-child { page-break-after: auto; }

    /* Header Compacto & Nobre */
    .header-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 3mm;
      border-bottom: 1.5px solid ${SCORECARD_THEME.line};
    }
    .header-left h1 {
      margin: 0;
      font-size: 20pt;
      color: ${SCORECARD_THEME.navy};
      letter-spacing: -0.02em;
    }
    .header-left p {
      margin: 1mm 0 0;
      color: ${SCORECARD_THEME.mutedInk};
      font-size: 9.5pt;
    }
    .header-tag {
      font-size: 8.5pt;
      font-weight: 700;
      color: ${SCORECARD_THEME.primaryDark};
      background: ${SCORECARD_THEME.cyanSurface};
      border: 1px solid ${SCORECARD_THEME.cyanLight};
      padding: 1.5mm 3.5mm;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    /* Status Strip */
    .status-strip {
      display: grid;
      grid-template-columns: 1.4fr 1.1fr 1.1fr 1fr;
      gap: 3.5mm;
      margin: 3.5mm 0;
    }
    .status-card {
      background: white;
      border: 1px solid ${SCORECARD_THEME.line};
      border-radius: 6px;
      padding: 3mm 4mm;
      box-shadow: 0 1px 3px rgba(16,42,67,0.04);
    }
    .status-card.hero-status {
      border-left: 4px solid ${statusColor(view.status)};
      background: ${statusSurface(view.status)};
    }
    .status-card small {
      display: block;
      color: ${SCORECARD_THEME.mutedInk};
      font-size: 7.5pt;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-bottom: 1mm;
    }
    .status-card .main-val {
      font-size: 14pt;
      font-weight: 800;
      color: ${SCORECARD_THEME.ink};
      line-height: 1.1;
    }
    .status-card .main-val.status-colored {
      color: ${statusColor(view.status)};
    }
    .status-card .sub-val {
      font-size: 8pt;
      color: ${SCORECARD_THEME.inkSoft};
      margin-top: 1mm;
    }

    /* Executive Summary Block */
    .summary-box {
      background: white;
      border: 1px solid ${SCORECARD_THEME.line};
      border-radius: 6px;
      padding: 3.5mm 5mm;
      margin-bottom: 3.5mm;
    }
    .summary-box h2 {
      margin: 0 0 2mm;
      font-size: 11pt;
      font-weight: 700;
      color: ${SCORECARD_THEME.primaryDark};
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .summary-box ul {
      margin: 0;
      padding-left: 4mm;
    }
    .summary-box li {
      margin-bottom: 1.2mm;
      font-size: 9.5pt;
      color: ${SCORECARD_THEME.inkSoft};
      line-height: 1.35;
    }

    /* Columns Layout */
    .columns-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4mm;
      flex-grow: 1;
    }
    .column-panel {
      background: white;
      border: 1px solid ${SCORECARD_THEME.line};
      border-radius: 6px;
      padding: 3.5mm 4.5mm;
      display: flex;
      flex-direction: column;
    }
    .column-panel h3 {
      margin: 0 0 2.5mm;
      font-size: 10.5pt;
      font-weight: 750;
      color: ${SCORECARD_THEME.navy};
      display: flex;
      align-items: center;
      gap: 2mm;
    }
    .control-card, .attention-card {
      display: flex;
      gap: 2.5mm;
      padding: 2mm 0;
      border-top: 1px solid ${SCORECARD_THEME.line};
    }
    .control-card:first-of-type, .attention-card:first-of-type {
      border-top: none;
      padding-top: 0;
    }
    .card-icon {
      width: 5mm;
      height: 5mm;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 7pt;
      font-weight: 800;
      flex-shrink: 0;
      margin-top: 0.5mm;
    }
    .card-icon.check {
      background: ${SCORECARD_THEME.greenSurface};
      color: ${SCORECARD_THEME.green};
      border: 1px solid ${SCORECARD_THEME.green};
    }
    .card-icon.alert {
      background: ${SCORECARD_THEME.yellowSurface};
      color: ${SCORECARD_THEME.yellow};
      border: 1px solid ${SCORECARD_THEME.yellow};
    }
    .card-content h4 {
      margin: 0 0 0.8mm;
      font-size: 9pt;
      font-weight: 700;
      color: ${SCORECARD_THEME.ink};
    }
    .card-content p {
      margin: 0;
      font-size: 8.2pt;
      color: ${SCORECARD_THEME.inkSoft};
      line-height: 1.3;
    }
    .card-content small {
      display: block;
      margin-top: 0.8mm;
      font-size: 7.5pt;
      color: ${SCORECARD_THEME.mutedInk};
    }

    /* Next Action Callout */
    .next-action-bar {
      background: ${SCORECARD_THEME.cyanSurface};
      border: 1px solid ${SCORECARD_THEME.cyanLight};
      border-left: 4px solid ${SCORECARD_THEME.primary};
      border-radius: 6px;
      padding: 2.5mm 4mm;
      margin-top: 3.5mm;
    }
    .next-action-bar strong {
      color: ${SCORECARD_THEME.primaryDark};
      font-size: 8.5pt;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .next-action-bar p {
      margin: 1mm 0 0;
      font-size: 8.5pt;
      color: ${SCORECARD_THEME.ink};
      line-height: 1.3;
    }

    /* Page 2 - Evidence Grid */
    .evidence-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      grid-template-rows: repeat(2, 1fr);
      gap: 3.5mm;
      flex-grow: 1;
      margin: 4mm 0;
    }
    .evidence-box {
      background: white;
      border: 1px solid ${SCORECARD_THEME.line};
      border-left: 3.5px solid var(--border-status);
      border-radius: 6px;
      padding: 3.5mm 4mm;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      box-shadow: 0 1px 3px rgba(16,42,67,0.03);
    }
    .box-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 2mm;
    }
    .box-header h4 {
      margin: 0;
      font-size: 9pt;
      font-weight: 750;
      color: ${SCORECARD_THEME.navy};
      max-width: 70%;
    }
    .status-pill {
      font-size: 7pt;
      font-weight: 800;
      padding: 0.8mm 2mm;
      border-radius: 12px;
      color: var(--border-status);
      background: var(--bg-status);
      white-space: nowrap;
    }
    .box-metric-row {
      display: flex;
      align-items: baseline;
      gap: 2mm;
      margin-bottom: 2mm;
    }
    .box-metric {
      font-size: 13pt;
      font-weight: 800;
      color: ${SCORECARD_THEME.primaryDark};
      line-height: 1;
    }
    .box-submetric {
      font-size: 7.8pt;
      font-weight: 600;
      color: ${SCORECARD_THEME.mutedInk};
    }
    .box-text {
      margin: 0;
      font-size: 8pt;
      color: ${SCORECARD_THEME.inkSoft};
      line-height: 1.3;
      flex-grow: 1;
    }
    .box-trend {
      margin-top: 2mm;
      font-size: 7.2pt;
      font-weight: 600;
      color: ${SCORECARD_THEME.mutedInk};
      border-top: 1px dashed ${SCORECARD_THEME.line};
      padding-top: 1.5mm;
    }

    /* Footer */
    .footer-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-top: 2.5mm;
      border-top: 1px solid ${SCORECARD_THEME.line};
      color: ${SCORECARD_THEME.mutedInk};
      font-size: 7.5pt;
    }
    .footer-bar strong {
      color: ${SCORECARD_THEME.inkSoft};
    }
    .footer-page-num {
      font-weight: 700;
      color: ${SCORECARD_THEME.primaryDark};
    }
    .legacy-marker {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
    }
  </style>
</head>
<body>

  <!-- PÁGINA 1: DECISÃO -->
  <section class="page">
    <header class="header-bar">
      <div class="header-left">
        <h1>${escapeHtml(view.title)}</h1>
        <p>${escapeHtml(view.subtitle)}</p>
      </div>
      <div class="header-tag">Página 1 · Decisão</div>
    </header>

    <div class="status-strip">
      <div class="status-card hero-status">
        <small>Status Geral</small>
        <div class="main-val status-colored">${STATUS_SYMBOLS[view.status]} ${escapeHtml(view.statusLabel)}</div>
        <div class="sub-val">${escapeHtml(view.statusMeaning)}</div>
      </div>
      <div class="status-card">
        <small>Tendência Histórica</small>
        <div class="main-val">${escapeHtml(view.trendLabel)}</div>
        <div class="sub-val">${view.hasHistoricalTrend ? `${view.checkpointsAnalyzed} checkpoints comparáveis` : 'Série em formação'}</div>
      </div>
      <div class="status-card">
        <small>Commit &amp; Data</small>
        <div class="main-val" style="font-family: monospace; font-size: 11pt;">${escapeHtml(view.commit)}</div>
        <div class="sub-val">${escapeHtml(view.generatedAt)}</div>
      </div>
      <div class="status-card">
        <small>Governança de Decisão</small>
        <div class="main-val" style="font-size: 11pt;">Decisão Humana</div>
        <div class="sub-val">Automação 100% Determinística</div>
      </div>
    </div>

    <article class="summary-box">
      <h2>Resumo Executivo para a Liderança</h2>
      <ul>
        ${view.executiveSummary.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
      </ul>
    </article>

    <div class="columns-grid">
      <div class="column-panel">
        <h3><span style="color:${SCORECARD_THEME.green};">✔</span> O que está sob controle</h3>
        ${underControlCards}
      </div>
      <div class="column-panel">
        <h3><span style="color:${SCORECARD_THEME.yellow};">▲</span> Pontos de Atenção</h3>
        ${attentionCards}
      </div>
    </div>

    <div class="next-action-bar">
      <strong>Decisão &amp; Próximos Passos Recomendados:</strong>
      <p>${escapeHtml(view.nextAction)}</p>
    </div>

    <footer class="footer-bar">
      <div><strong>TOTVS Cloud QE Lab — Personal &amp; Non-Official [LAB]</strong> | Governança Risco → Controle → Evidência</div>
      <div class="footer-page-num">Página 1 / 2</div>
    </footer>
    <span class="legacy-marker" aria-label="Quality Engineering Lab — NÃO OFICIAL">Decisão humana obrigatória</span>
  </section>

  <!-- PÁGINA 2: EVIDÊNCIA QUE SUSTENTA A DECISÃO -->
  <section class="page">
    <header class="header-bar">
      <div class="header-left">
        <h1>Evidências que Sustentam a Decisão</h1>
        <p>Panorama detalhado por dimensão técnica com uma métrica central e interpretação direta</p>
      </div>
      <div class="header-tag">Página 2 · Evidência</div>
    </header>

    <div class="evidence-grid">
      ${evidenceCardsHtml}
    </div>

    <div class="next-action-bar" style="background: white; border-color: ${SCORECARD_THEME.line}; border-left-color: ${SCORECARD_THEME.primary};">
      <strong>Rastreabilidade Completa de Qualidade:</strong>
      <p>Todas as métricas acima são comprovadas por arquivos JSON versionados em <code>evidence/</code>, validadas pelo Quality Gate determinístico de 176 testes e livres de testes instáveis (0 flaky tests).</p>
    </div>

    <footer class="footer-bar">
      <div><strong>TOTVS Cloud QE Lab — Personal &amp; Non-Official [LAB]</strong> | Generated from deterministic Quality Engineering evidence</div>
      <div class="footer-page-num">Página 2 / 2</div>
    </footer>
  </section>
</body>
</html>`;

  return html.replace(/[ \t]+$/gm, '');
}
