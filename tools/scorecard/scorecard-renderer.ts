import type {
  ExecutiveScorecard,
  QualityStatus,
  QualityTrend,
  ScorecardDimension,
} from './scorecard-schema.js';
import { SCORECARD_THEME, statusColor, statusSurface } from './scorecard-theme.js';

const DIMENSION_ORDER = [
  'RISK_COVERAGE',
  'CONTROLS',
  'CRITICAL_JOURNEYS',
  'RESILIENCE',
  'OBSERVABILITY',
  'PERFORMANCE',
  'REGRESSION',
  'SECURITY',
  'KNOWN_GAPS',
] as const;

const DIMENSION_LABELS: Record<(typeof DIMENSION_ORDER)[number], string> = {
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

const STATUS_LABELS: Record<QualityStatus, string> = {
  GREEN: 'VERDE',
  YELLOW: 'AMARELO',
  RED: 'VERMELHO',
  UNKNOWN: 'SEM EVIDÊNCIA',
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
  UNKNOWN: 'Sem histórico',
};

export interface ExecutiveDimensionView {
  key: (typeof DIMENSION_ORDER)[number];
  label: string;
  status: QualityStatus;
  statusLabel: string;
  trendLabel: string;
  metric: string;
  interpretation: string;
}

export interface ExecutiveAttentionView {
  title: string;
  impact: string;
  evidence: string;
}

export interface ExecutiveScorecardView {
  title: string;
  subtitle: string;
  status: QualityStatus;
  statusLabel: string;
  statusMeaning: string;
  trendLabel: string;
  generatedAt: string;
  commit: string;
  executiveSummary: string[];
  dimensions: ExecutiveDimensionView[];
  attention: ExecutiveAttentionView[];
  underControl: string[];
  gaps: string[];
  actions: string[];
  trendDisclaimer: string;
  syntheticSlaDisclaimer: string;
}

const escapeHtml = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

function indicatorValue(dimension: ScorecardDimension | undefined, key: string): string | number | undefined {
  return dimension?.indicators.find((indicator) => indicator.key === key)?.value;
}

function dimensionByKey(scorecard: ExecutiveScorecard, key: string): ScorecardDimension | undefined {
  return scorecard.dimensions.find((dimension) => dimension.key === key);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(value);
}

function formatGeneratedAt(value: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Sao_Paulo',
  }).format(new Date(value));
}

function comparisonLabel(value: string | number | undefined): string {
  if (value === 'IMPROVED') return 'Melhorou';
  if (value === 'STABLE') return 'Estável';
  if (value === 'REGRESSED') return 'Regrediu';
  return 'Sem referência';
}

function executiveGap(gap: string): string {
  const observability = gap.match(/^(\d+) cenários? de observabilidade possuem cadeia parcial de spans/);
  if (observability) {
    const count = Number(observability[1]);
    return count === 1
      ? '1 cenário de observabilidade possui cadeia parcial de rastreamento e exige interpretação humana.'
      : `${count} cenários de observabilidade possuem cadeia parcial de rastreamento e exigem interpretação humana.`;
  }
  if (gap.startsWith('Baseline e current')) {
    return 'A comparação entre a referência e a execução atual ainda não forma uma série histórica.';
  }
  return gap;
}

function dimensionMetric(scorecard: ExecutiveScorecard, key: (typeof DIMENSION_ORDER)[number]): string {
  const dimension = dimensionByKey(scorecard, key);
  if (key === 'RISK_COVERAGE') return `${formatNumber(scorecard.summary.riskCoveragePct)}% cobertos`;
  if (key === 'CONTROLS') return `${scorecard.summary.controlsPassed} aprovados`;
  if (key === 'CRITICAL_JOURNEYS') return `${scorecard.summary.journeysPassed}/${scorecard.summary.journeysTotal} aprovadas`;
  if (key === 'RESILIENCE') return `${indicatorValue(dimension, 'resilience-passed') ?? 0} cenários aprovados`;
  if (key === 'OBSERVABILITY') return `${indicatorValue(dimension, 'traces') ?? 0} rastros analisados`;
  if (key === 'PERFORMANCE') {
    const p95 = indicatorValue(dimension, 'p95');
    return `p95 de ${typeof p95 === 'number' ? formatNumber(p95) : (p95 ?? '-')} ms`;
  }
  if (key === 'REGRESSION') return comparisonLabel(indicatorValue(dimension, 'comparison'));
  if (key === 'SECURITY') return `${indicatorValue(dimension, 'security-findings') ?? 0} findings`;
  return `${scorecard.summary.knownGapCount} lacunas explícitas`;
}

function dimensionInterpretation(scorecard: ExecutiveScorecard, key: (typeof DIMENSION_ORDER)[number]): string {
  const dimension = dimensionByKey(scorecard, key);
  if (key === 'RISK_COVERAGE') {
    return scorecard.summary.controlsUnknown > 0
      ? `${scorecard.summary.controlsUnknown} riscos ainda aguardam evidência nesta coleta.`
      : 'Todos os riscos conhecidos possuem evidência nesta coleta.';
  }
  if (key === 'CONTROLS') {
    return scorecard.summary.controlsFailed > 0
      ? `${scorecard.summary.controlsFailed} controles falharam e exigem tratamento.`
      : 'Nenhum controle exercitado apresentou falha.';
  }
  if (key === 'CRITICAL_JOURNEYS') return 'As jornadas avaliadas atenderam aos limites sintéticos [LAB].';
  if (key === 'RESILIENCE') return 'Os cenários exercitados recuperaram o fluxo esperado.';
  if (key === 'OBSERVABILITY') {
    const partial = indicatorValue(dimension, 'missing-spans') ?? 0;
    return Number(partial) > 0
      ? `${partial} cadeia parcial reduz a confiança no diagnóstico.`
      : 'Os fluxos avaliados permanecem rastreáveis.';
  }
  if (key === 'PERFORMANCE') return 'Os limites sintéticos foram atendidos na execução registrada.';
  if (key === 'REGRESSION') return 'Comparação pontual favorável; ainda não há série histórica.';
  if (key === 'SECURITY') return 'Scanners locais ativos; o gap IAM mantém revisão humana obrigatória.';
  return 'As lacunas seguem visíveis e não contam como sucesso.';
}

export function buildExecutiveScorecardView(scorecard: ExecutiveScorecard): ExecutiveScorecardView {
  const observability = dimensionByKey(scorecard, 'OBSERVABILITY');
  const partialChains = Number(indicatorValue(observability, 'missing-spans') ?? 0);
  const dimensions = DIMENSION_ORDER.map((key) => {
    const dimension = dimensionByKey(scorecard, key);
    const status = dimension?.status ?? 'UNKNOWN';
    return {
      key,
      label: DIMENSION_LABELS[key],
      status,
      statusLabel: STATUS_LABELS[status],
      trendLabel: TREND_LABELS[dimension?.trend ?? 'UNKNOWN'],
      metric: dimensionMetric(scorecard, key),
      interpretation: dimensionInterpretation(scorecard, key),
    };
  });

  const attention: ExecutiveAttentionView[] = [];
  if (scorecard.summary.controlsFailed > 0) {
    attention.push({
      title: 'Controles com falha',
      impact: 'O resultado atual aponta perda objetiva de qualidade nas áreas exercitadas.',
      evidence: `${scorecard.summary.controlsFailed} controle(s) com resultado de falha no scorecard.`,
    });
  }
  if (scorecard.summary.controlsUnknown > 0) {
    attention.push({
      title: 'Cobertura de evidência parcial',
      impact: 'A leitura não permite o mesmo nível de confiança para todo o mapa de riscos.',
      evidence: `${scorecard.summary.controlsUnknown} de ${scorecard.summary.knownRisks} riscos conhecidos não possuem evidência nesta coleta.`,
    });
  }
  if (partialChains > 0) {
    const scenarioLabel = partialChains === 1 ? '1 cenário' : `${partialChains} cenários`;
    attention.push({
      title: 'Rastreabilidade incompleta',
      impact: 'Uma investigação de falha pode exigir correlação manual adicional.',
      evidence: `${scenarioLabel} de observabilidade possui cadeia parcial.`,
    });
  }
  if (scorecard.overallTrend === 'UNKNOWN' || scorecard.trendDisclaimer.toLowerCase().includes('não constitui série histórica')) {
    attention.push({
      title: 'Tendência ainda pontual',
      impact: 'A direção observada não demonstra comportamento sustentado ao longo do tempo.',
      evidence: scorecard.trendDisclaimer,
    });
  }
  for (const gap of scorecard.knownGaps) {
    if (attention.length >= 5) break;
    const alreadyCovered = attention.some((item) => item.evidence.includes(gap))
      || gap.includes('riscos conhecidos')
      || gap.includes('cadeia parcial')
      || gap.includes('série histórica');
    if (!alreadyCovered) {
      attention.push({ title: 'Limite de evidência', impact: 'A lacuna reduz a confiança executiva da leitura.', evidence: gap });
    }
  }

  const underControl = [
    scorecard.summary.controlsFailed === 0
      ? `${scorecard.summary.controlsPassed} controles exercitados foram aprovados, sem falhas registradas.`
      : `${scorecard.summary.controlsPassed} controles foram aprovados; as falhas permanecem destacadas.`,
    `${scorecard.summary.journeysPassed}/${scorecard.summary.journeysTotal} jornadas críticas atenderam aos critérios [LAB].`,
    `${scorecard.summary.syntheticSlaMet}/${scorecard.summary.syntheticSlaTotal} limites sintéticos foram atendidos.`,
    `${indicatorValue(dimensionByKey(scorecard, 'RESILIENCE'), 'resilience-passed') ?? 0} cenários de resiliência preservaram a recuperação esperada.`,
    dimensionByKey(scorecard, 'PERFORMANCE')?.status === 'GREEN'
      ? 'Os limites de desempenho e duplicidade avaliados foram atendidos.'
      : 'O desempenho permanece sinalizado conforme a evidência atual.',
  ];

  const actions = [
    scorecard.summary.controlsUnknown > 0
      ? `1. Priorizar evidências para os ${scorecard.summary.controlsUnknown} riscos ainda não exercitados.`
      : '1. Manter a cobertura atual e revisar novos riscos a cada mudança.',
    partialChains > 0
      ? '2. Completar a cadeia de rastreabilidade do cenário parcial.'
      : '2. Preservar a rastreabilidade completa nas próximas evoluções.',
    '3. Acumular execuções comparáveis antes de declarar tendência histórica.',
    '4. Submeter lacunas e sinais amarelos à revisão humana antes de qualquer decisão.',
  ];

  return {
    title: 'Quality Engineering Executive Scorecard',
    subtitle: 'Visão executiva da qualidade do laboratório Cloud Control Plane [LAB]',
    status: scorecard.overallStatus,
    statusLabel: STATUS_LABELS[scorecard.overallStatus],
    statusMeaning: STATUS_MEANINGS[scorecard.overallStatus],
    trendLabel: TREND_LABELS[scorecard.overallTrend],
    generatedAt: formatGeneratedAt(scorecard.generatedAt),
    commit: scorecard.commit,
    executiveSummary: [
      `A situação geral está em ${STATUS_LABELS[scorecard.overallStatus].toLowerCase()}: ${STATUS_MEANINGS[scorecard.overallStatus].toLowerCase()}.`,
      `Principal risco: ${scorecard.summary.controlsUnknown} de ${scorecard.summary.knownRisks} riscos conhecidos ainda não possuem evidência nesta coleta.`,
      `Principal força: ${scorecard.summary.controlsPassed} controles exercitados foram aprovados, sem falhas registradas.`,
      `Principal lacuna: ${partialChains > 0 ? `${partialChains} cadeia de rastreabilidade está parcial e não há série histórica.` : 'a comparação ainda não constitui série histórica.'}`,
      `Prioridade recomendada: ampliar a cobertura de evidência e ${partialChains > 0 ? 'fechar a rastreabilidade parcial' : 'consolidar uma série comparável'}.`,
    ],
    dimensions,
    attention: attention.slice(0, 5),
    underControl,
    gaps: scorecard.knownGaps.map(executiveGap),
    actions,
    trendDisclaimer: scorecard.trendDisclaimer,
    syntheticSlaDisclaimer: scorecard.syntheticSlaDisclaimer,
  };
}

function dimensionCard(dimension: ExecutiveDimensionView): string {
  return `<article class="dimension" style="--status:${statusColor(dimension.status)};--status-bg:${statusSurface(dimension.status)}">
    <div class="dimension-head"><h3>${escapeHtml(dimension.label)}</h3><span class="badge">${escapeHtml(dimension.statusLabel)}</span></div>
    <div class="dimension-metric">${escapeHtml(dimension.metric)}</div>
    <p>${escapeHtml(dimension.interpretation)}</p>
    <div class="dimension-trend">Direção: ${escapeHtml(dimension.trendLabel)}</div>
  </article>`;
}

function listItems(items: string[]): string {
  return items.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
}

export function renderExecutiveSummaryMarkdown(scorecard: ExecutiveScorecard): string {
  const view = buildExecutiveScorecardView(scorecard);
  const dimensions = view.dimensions.flatMap((dimension) => [
    `### ${dimension.label} - ${dimension.statusLabel}`,
    '',
    `**${dimension.metric}.** ${dimension.interpretation} Direção: ${dimension.trendLabel}.`,
    '',
  ]);
  const attention = view.attention.map((item) => `- **${item.title}.** Impacto: ${item.impact} Evidência: ${item.evidence}`);
  return [
    `# ${view.title}`,
    '',
    `> ${view.subtitle}`,
    '',
    `- **Status geral:** ${view.statusLabel} - ${view.statusMeaning}`,
    `- **Tendência:** ${view.trendLabel}`,
    `- **Gerado em:** ${view.generatedAt}`,
    `- **Commit analisado:** \`${view.commit}\``,
    '- **Contexto:** Personal & Non-Official [LAB]',
    '',
    '## Resumo Executivo',
    '',
    ...view.executiveSummary.map((item) => `- ${item}`),
    '',
    '## Visão por Dimensão',
    '',
    ...dimensions,
    '## Principais Pontos de Atenção',
    '',
    ...(attention.length > 0 ? attention : ['- Nenhum ponto de atenção adicional foi identificado nesta coleta.']),
    '',
    '## O que está sob controle',
    '',
    ...view.underControl.map((item) => `- ${item}`),
    '',
    '## Gaps e Limites Atuais',
    '',
    ...view.gaps.map((gap) => `- ${gap}`),
    '',
    `- ${view.trendDisclaimer}`,
    `- ${view.syntheticSlaDisclaimer}`,
    '',
    '## Ações Recomendadas',
    '',
    ...view.actions,
    '',
    '> Este scorecard apoia a decisão profissional. A decisão humana é obrigatória e nenhuma leitura automatizada aprova ou reprova uma release.',
    '',
    '**TOTVS Cloud QE Lab — Personal & Non-Official [LAB]**',
    '',
    'Generated from deterministic Quality Engineering evidence',
    '',
  ].join('\n');
}

export function renderScorecardHtml(scorecard: ExecutiveScorecard): string {
  const view = buildExecutiveScorecardView(scorecard);
  const dimensions = view.dimensions.map(dimensionCard).join('');
  const attention = view.attention.map((item, index) => `<article class="attention-item"><span>${String(index + 1).padStart(2, '0')}</span><div><h3>${escapeHtml(item.title)}</h3><p><strong>Impacto:</strong> ${escapeHtml(item.impact)}</p><small><strong>Evidência:</strong> ${escapeHtml(item.evidence)}</small></div></article>`).join('');
  const footer = `<footer class="footer"><div><strong>TOTVS Cloud QE Lab — Personal & Non-Official [LAB]</strong><br><span>Generated from deterministic Quality Engineering evidence</span></div>`;
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(view.title)} - AI-05</title>
<style>
@page{size:A4 landscape;margin:0}*{box-sizing:border-box}html{background:${SCORECARD_THEME.canvas}}body{margin:0;color:${SCORECARD_THEME.ink};font-family:Inter,"Segoe UI",Arial,sans-serif;font-size:14px;line-height:1.45}.page{width:297mm;min-height:210mm;margin:0 auto;padding:13mm 15mm 14mm;page-break-after:always;position:relative;overflow:hidden;background:${SCORECARD_THEME.canvas}}.page:last-child{page-break-after:auto}.hero{margin:-13mm -15mm 7mm;padding:11mm 15mm 10mm;color:white;background:radial-gradient(circle at 82% -35%,${SCORECARD_THEME.cyan} 0,transparent 34%),linear-gradient(118deg,${SCORECARD_THEME.navy} 0%,${SCORECARD_THEME.primaryDark} 72%,${SCORECARD_THEME.primary} 100%);border-bottom:1.5mm solid ${SCORECARD_THEME.cyan}}.eyebrow{font-size:10px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:${SCORECARD_THEME.cyanLight}}.hero h1{margin:3mm 0 2mm;font-size:30px;line-height:1.05;letter-spacing:-.025em}.hero p{margin:0;color:#D9F4FA;font-size:13px}.summary-strip{display:grid;grid-template-columns:1.25fr 1fr 1.25fr 1.15fr 1.5fr;gap:3mm;margin-bottom:6mm}.summary-cell{min-height:23mm;padding:4mm;background:white;border:1px solid ${SCORECARD_THEME.line};border-radius:3mm;box-shadow:0 2mm 6mm rgba(14,45,83,.06)}.summary-cell:first-child{border-left:2mm solid ${statusColor(view.status)}}.summary-cell small{display:block;margin-bottom:1mm;color:${SCORECARD_THEME.mutedInk};font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.summary-cell strong{display:block;font-size:17px;line-height:1.1}.summary-cell .status{color:${statusColor(view.status)};font-size:22px}.summary-cell span{display:block;margin-top:1mm;color:${SCORECARD_THEME.mutedInk};font-size:9px}.panel{background:white;border:1px solid ${SCORECARD_THEME.line};border-radius:4mm;box-shadow:0 2mm 7mm rgba(14,45,83,.06)}.executive{padding:6mm 7mm}.section-kicker{margin:0 0 1mm;color:${SCORECARD_THEME.primary};font-size:9px;font-weight:800;letter-spacing:.14em;text-transform:uppercase}.section-title{margin:0 0 4mm;font-size:21px;line-height:1.15}.executive ul{display:grid;grid-template-columns:1fr 1fr;gap:3mm 9mm;margin:0;padding:0;list-style:none}.executive li{position:relative;padding-left:5mm;font-size:11px}.executive li::before{content:"";position:absolute;left:0;top:.55em;width:2mm;height:2mm;border-radius:50%;background:${SCORECARD_THEME.cyan}}.quick-read{display:grid;grid-template-columns:repeat(3,1fr);gap:4mm;margin-top:5mm}.quick-card{padding:4mm 5mm;border-radius:3mm;background:${SCORECARD_THEME.surfaceSoft};border:1px solid ${SCORECARD_THEME.line}}.quick-card small{color:${SCORECARD_THEME.mutedInk};font-size:9px;font-weight:700;text-transform:uppercase}.quick-card strong{display:block;margin-top:1.5mm;font-size:11px}.quick-card.attention{border-left:1.5mm solid ${SCORECARD_THEME.yellow}}.quick-card.control{border-left:1.5mm solid ${SCORECARD_THEME.green}}.quick-card.action{border-left:1.5mm solid ${SCORECARD_THEME.primary}}.page-heading{display:flex;align-items:end;justify-content:space-between;margin-bottom:6mm}.page-heading h2{margin:0;font-size:24px}.page-heading p{max-width:115mm;margin:0;color:${SCORECARD_THEME.mutedInk};font-size:11px;text-align:right}.dimension-grid{display:grid;grid-template-columns:1fr 1fr;gap:4mm}.dimension{min-height:34mm;padding:4.5mm 5mm;background:white;border:1px solid ${SCORECARD_THEME.line};border-left:1.8mm solid var(--status);border-radius:3mm;box-shadow:0 1.5mm 5mm rgba(14,45,83,.05)}.dimension-head{display:flex;align-items:center;justify-content:space-between;gap:4mm}.dimension h3{margin:0;font-size:14px}.badge{display:inline-block;padding:1.2mm 2.7mm;color:var(--status);background:var(--status-bg);border-radius:10mm;font-size:8px;font-weight:800;letter-spacing:.06em}.dimension-metric{margin:2mm 0 1mm;color:${SCORECARD_THEME.primaryDark};font-size:20px;font-weight:750;line-height:1}.dimension p{margin:0;color:${SCORECARD_THEME.inkSoft};font-size:10px}.dimension-trend{margin-top:1.5mm;color:${SCORECARD_THEME.mutedInk};font-size:8.5px}.management-grid{display:grid;grid-template-columns:1.08fr .92fr;gap:5mm}.column{display:grid;gap:5mm}.block{padding:5.5mm 6mm}.block h2{margin:0 0 4mm;font-size:17px}.attention-item{display:grid;grid-template-columns:8mm 1fr;gap:3mm;padding:3mm 0;border-top:1px solid ${SCORECARD_THEME.line}}.attention-item:first-of-type{border-top:0;padding-top:0}.attention-item>span{display:flex;align-items:center;justify-content:center;width:7mm;height:7mm;color:white;background:${SCORECARD_THEME.yellow};border-radius:50%;font-size:8px;font-weight:800}.attention-item h3{margin:0 0 .6mm;font-size:11px}.attention-item p{margin:0;font-size:9px}.attention-item small{display:block;margin-top:.8mm;color:${SCORECARD_THEME.mutedInk};font-size:8px}.clean-list,.action-list{margin:0;padding:0;list-style:none}.clean-list li,.action-list li{position:relative;margin:0 0 2.3mm;padding-left:5mm;font-size:9.5px}.clean-list li::before{content:"";position:absolute;left:0;top:.55em;width:2.2mm;height:2.2mm;border-radius:50%;background:${SCORECARD_THEME.green}}.gap-list li::before{background:${SCORECARD_THEME.yellow}}.action-list{counter-reset:action}.action-list li{padding:3mm 3mm 3mm 12mm;background:${SCORECARD_THEME.surfaceSoft};border-radius:2mm}.action-list li::before{counter-increment:action;content:counter(action);position:absolute;left:3mm;top:2.6mm;display:flex;align-items:center;justify-content:center;width:6mm;height:6mm;color:white;background:${SCORECARD_THEME.primary};border-radius:1.5mm;font-size:8px;font-weight:800}.governance{margin-top:5mm;padding:4mm 5mm;border:1px solid ${SCORECARD_THEME.cyan};border-radius:3mm;background:${SCORECARD_THEME.cyanSurface};font-size:9px}.footer{position:absolute;left:15mm;right:15mm;bottom:4mm;display:flex;align-items:end;justify-content:space-between;padding-top:2mm;border-top:1px solid ${SCORECARD_THEME.line};color:${SCORECARD_THEME.mutedInk};font-size:7px}.footer strong{font-size:7.5px;color:${SCORECARD_THEME.inkSoft}}.footer-page{font-weight:700}.legacy-marker{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}@media screen{body{padding:14px}.page{margin-bottom:16px;box-shadow:0 8px 30px rgba(14,45,83,.14)}}@media print{body{background:white}.page{margin:0;box-shadow:none}}
.dimension-grid{grid-template-columns:repeat(3,1fr)}.dimension{min-height:42mm}
</style></head><body>
<section class="page"><header class="hero"><div class="eyebrow">AI-05 · Quality Engineering</div><h1>${escapeHtml(view.title)}</h1><p>${escapeHtml(view.subtitle)}</p></header>
<div class="summary-strip"><div class="summary-cell"><small>Status geral</small><strong class="status">${escapeHtml(view.statusLabel)}</strong><span>${escapeHtml(view.statusMeaning)}</span></div><div class="summary-cell"><small>Tendência</small><strong>${escapeHtml(view.trendLabel)}</strong><span>Leitura pontual</span></div><div class="summary-cell"><small>Data e hora</small><strong>${escapeHtml(view.generatedAt)}</strong><span>Horário de Brasília</span></div><div class="summary-cell"><small>Commit</small><strong>${escapeHtml(view.commit)}</strong><span>Referência analisada</span></div><div class="summary-cell"><small>Contexto</small><strong>Personal &amp; Non-Official</strong><span>[LAB]</span></div></div>
<article class="panel executive"><p class="section-kicker">Leitura para decisão</p><h2 class="section-title">Resumo Executivo</h2><ul>${listItems(view.executiveSummary)}</ul></article>
<div class="quick-read"><article class="quick-card attention"><small>Principal atenção</small><strong>${escapeHtml(view.attention[0]?.title ?? 'Nenhuma atenção adicional')}</strong></article><article class="quick-card control"><small>Sob controle</small><strong>${scorecard.summary.controlsPassed} controles aprovados e ${scorecard.summary.controlsFailed} falhos</strong></article><article class="quick-card action"><small>Prioridade</small><strong>Ampliar cobertura e confiança das evidências</strong></article></div>
${footer}<span class="footer-page">1/3</span></footer><span class="legacy-marker" aria-label="Quality Engineering Lab — NÃO OFICIAL">Decisão humana obrigatória</span></section>
<section class="page"><div class="page-heading"><div><p class="section-kicker">Panorama integrado</p><h2>Visão por Dimensão</h2></div><p>Uma métrica central e uma interpretação curta por dimensão. Os códigos determinísticos permanecem preservados no JSON.</p></div><div class="dimension-grid">${dimensions}</div>${footer}<span class="footer-page">2/3</span></footer></section>
<section class="page"><div class="page-heading"><div><p class="section-kicker">Foco de gestão</p><h2>Atenções, controles e próximos passos</h2></div><p>A leitura automatizada organiza evidência. A decisão permanece exclusivamente humana.</p></div><div class="management-grid"><div class="column"><article class="panel block"><h2>Principais Pontos de Atenção</h2>${attention || '<p>Nenhum ponto adicional nesta coleta.</p>'}</article><article class="panel block"><h2>Ações Recomendadas</h2><ol class="action-list">${listItems(view.actions.map((item) => item.replace(/^\d+\.\s*/, '')))}</ol></article></div><div class="column"><article class="panel block"><h2>O que está sob controle</h2><ul class="clean-list">${listItems(view.underControl)}</ul></article><article class="panel block"><h2>Gaps e Limites Atuais</h2><ul class="clean-list gap-list">${listItems([...view.gaps, view.trendDisclaimer, view.syntheticSlaDisclaimer])}</ul></article></div></div><div class="governance"><strong>Governança:</strong> este material sintetiza evidências determinísticas do laboratório. Não aprova nem reprova release e não substitui revisão profissional.</div>${footer}<span class="footer-page">3/3</span></footer></section>
</body></html>`;
}
