import type { ExecutiveScorecard, QualityStatus } from './scorecard-schema.js';
import { SCORECARD_THEME, statusColor, statusSurface } from './scorecard-theme.js';

const escapeHtml = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

function indicatorCard(label: string, value: string, status: QualityStatus): string {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong style="color:${statusColor(status)}">${escapeHtml(value)}</strong></div>`;
}

function dimensionCard(scorecard: ExecutiveScorecard, index: number): string {
  const dimension = scorecard.dimensions[index];
  if (!dimension) return '';
  const indicators = dimension.indicators.slice(0, 4).map((indicator) => indicatorCard(
    indicator.label,
    `${indicator.value}${indicator.unit ? ` ${indicator.unit}` : ''}`,
    indicator.status,
  )).join('');
  return `<article class="dimension" style="--status:${statusColor(dimension.status)};--status-bg:${statusSurface(dimension.status)}">
    <div class="dimension-head"><div><small>${escapeHtml(dimension.key)}</small><h3>${escapeHtml(dimension.label)}</h3></div><span class="pill">${dimension.status}</span></div>
    <div class="trend">Tendência: <strong>${dimension.trend}</strong></div>
    <div class="metrics">${indicators}</div>
    <p>${escapeHtml(dimension.explanation)}</p>
    <div class="risk-line">Riscos: ${dimension.risks.length > 0 ? dimension.risks.map(escapeHtml).join(', ') : 'nenhum risco específico'}</div>
  </article>`;
}

export function renderExecutiveSummaryMarkdown(scorecard: ExecutiveScorecard): string {
  const rows = scorecard.dimensions.map((dimension) => `| ${dimension.label} | ${dimension.status} | ${dimension.trend} | ${dimension.explanation} |`);
  return [
    '# Executive Quality Scorecard — AI-05',
    '',
    '> [LAB] Síntese determinística e não oficial. A decisão permanece humana.',
    '',
    `- Status geral: **${scorecard.overallStatus}**`,
    `- Tendência pontual: **${scorecard.overallTrend}**`,
    `- Riscos exercitados: **${scorecard.summary.exercisedRisks}/${scorecard.summary.knownRisks} (${scorecard.summary.riskCoveragePct}%)**`,
    `- Controles: **${scorecard.summary.controlsPassed} aprovados / ${scorecard.summary.controlsFailed} falhos / ${scorecard.summary.controlsUnknown} sem evidência nesta coleta**`,
    `- Jornadas: **${scorecard.summary.journeysPassed}/${scorecard.summary.journeysTotal} aprovadas**`,
    `- SLAs sintéticos: **${scorecard.summary.syntheticSlaMet}/${scorecard.summary.syntheticSlaTotal} atendidos**`,
    '',
    '| Dimensão | Status | Tendência | Explicação |',
    '|---|---|---|---|',
    ...rows,
    '',
    '## Gaps conhecidos',
    '',
    ...scorecard.knownGaps.map((gap) => `- ${gap}`),
    '',
    `> ${scorecard.trendDisclaimer}`,
    '',
    `> ${scorecard.syntheticSlaDisclaimer}`,
    '',
    '**Quality Engineering Lab — NÃO OFICIAL | Evidências do laboratório | Decisão humana obrigatória**',
    '',
  ].join('\n');
}

export function renderScorecardHtml(scorecard: ExecutiveScorecard): string {
  const firstCards = [1, 2, 3, 4].map((index) => dimensionCard(scorecard, index)).join('');
  const secondCards = [5, 6, 7, 8].map((index) => dimensionCard(scorecard, index)).join('');
  const gaps = scorecard.knownGaps.map((gap) => `<li>${escapeHtml(gap)}</li>`).join('');
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Executive Quality Scorecard — AI-05</title>
<style>
@page{size:A4 landscape;margin:0}*{box-sizing:border-box}body{margin:0;background:${SCORECARD_THEME.canvas};color:${SCORECARD_THEME.ink};font-family:Inter,"Segoe UI",Arial,sans-serif}.page{width:297mm;min-height:210mm;margin:0 auto;padding:14mm 15mm 12mm;page-break-after:always;position:relative;background:${SCORECARD_THEME.canvas}}.page:last-child{page-break-after:auto}.hero{background:${SCORECARD_THEME.ink};color:white;margin:-14mm -15mm 9mm;padding:13mm 15mm 9mm;border-left:3mm solid ${SCORECARD_THEME.accent}}.eyebrow{font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:#bfe8ed}.hero h1{margin:4px 0 6px;font-size:27px;line-height:1.05}.hero p{margin:0;color:#dbe7f0;font-size:11px}.status-grid{display:grid;grid-template-columns:1.5fr repeat(4,1fr);gap:4mm;margin-bottom:7mm}.overall,.headline{background:white;border:1px solid ${SCORECARD_THEME.line};border-radius:3mm;padding:5mm}.overall{border-top:2mm solid ${statusColor(scorecard.overallStatus)}}.overall small,.headline span{display:block;color:${SCORECARD_THEME.mutedInk};font-size:9px;text-transform:uppercase;letter-spacing:.08em}.overall strong{display:block;font-size:31px;color:${statusColor(scorecard.overallStatus)};margin:2mm 0}.headline strong{display:block;font-size:22px;margin:3mm 0 1mm}.grid{display:grid;grid-template-columns:1fr 1fr;gap:5mm}.dimension{background:white;border:1px solid ${SCORECARD_THEME.line};border-top:2mm solid var(--status);border-radius:3mm;padding:5mm;min-height:68mm;break-inside:avoid}.dimension-head{display:flex;justify-content:space-between;gap:4mm;align-items:flex-start}.dimension small{font-size:7px;color:${SCORECARD_THEME.mutedInk};letter-spacing:.08em}.dimension h3{font-size:15px;margin:1mm 0}.pill{font-size:8px;font-weight:700;color:var(--status);background:var(--status-bg);padding:2mm 3mm;border-radius:10mm}.trend{font-size:9px;color:${SCORECARD_THEME.mutedInk};margin:2mm 0 3mm}.metrics{display:grid;grid-template-columns:1fr 1fr;gap:2mm}.metric{background:${SCORECARD_THEME.canvas};padding:2.5mm;border-radius:2mm;display:flex;justify-content:space-between;gap:2mm;font-size:8px}.dimension p{font-size:9px;line-height:1.4;margin:3mm 0}.risk-line{font-size:7.5px;color:${SCORECARD_THEME.mutedInk}}.decision{margin-top:5mm;padding:4mm 5mm;border:1px solid #abd7dd;background:#e7f4f6;border-radius:3mm}.decision strong{color:${SCORECARD_THEME.accentDark}}.decision p{font-size:9px;margin:2mm 0 0}.section-title{font-size:19px;margin:0 0 5mm}.gaps{background:white;border:1px solid ${SCORECARD_THEME.line};border-radius:3mm;padding:6mm}.gaps li{margin:0 0 3mm;font-size:10px;line-height:1.4}.disclaimer{display:grid;grid-template-columns:1fr 1fr;gap:5mm;margin-top:6mm}.note{background:#fff;border-left:2mm solid ${SCORECARD_THEME.yellow};padding:5mm;font-size:9px;line-height:1.4}.footer{position:absolute;left:15mm;right:15mm;bottom:5mm;border-top:1px solid ${SCORECARD_THEME.line};padding-top:2mm;color:${SCORECARD_THEME.mutedInk};font-size:7px;display:flex;justify-content:space-between}@media screen{body{padding:10px}.page{box-shadow:0 4px 22px #1a294026;margin-bottom:12px}}@media print{body{background:white}.page{margin:0;box-shadow:none}}
</style></head><body>
<section class="page"><header class="hero"><div class="eyebrow">Quality Engineering · AI-05</div><h1>Executive Quality Scorecard</h1><p>[LAB] Cloud Control Plane fictício · evidências determinísticas · decisão humana</p></header>
<div class="status-grid"><div class="overall"><small>Status geral</small><strong>${scorecard.overallStatus}</strong><span>Tendência pontual: ${scorecard.overallTrend}</span></div><div class="headline"><span>Riscos exercitados</span><strong>${scorecard.summary.exercisedRisks}/${scorecard.summary.knownRisks}</strong><span>${scorecard.summary.riskCoveragePct}%</span></div><div class="headline"><span>Controles aprovados</span><strong>${scorecard.summary.controlsPassed}</strong><span>${scorecard.summary.controlsFailed} falhos</span></div><div class="headline"><span>Jornadas</span><strong>${scorecard.summary.journeysPassed}/${scorecard.summary.journeysTotal}</strong><span>aprovadas</span></div><div class="headline"><span>SLA sintético</span><strong>${scorecard.summary.syntheticSlaMet}/${scorecard.summary.syntheticSlaTotal}</strong><span>limites [LAB]</span></div></div>
<div class="grid">${firstCards}</div><div class="decision"><strong>Decisão humana obrigatória</strong><p>Este painel sintetiza evidências do laboratório. Não aprova nem reprova release e não substitui revisão profissional.</p></div><footer class="footer"><span>Quality Engineering Lab — NÃO OFICIAL | Evidências do laboratório | Decisão humana obrigatória</span><span>1/2</span></footer></section>
<section class="page"><h2 class="section-title">Sinais técnicos, regressão e gaps conhecidos</h2><div class="grid">${secondCards}</div><div class="gaps"><h3>Limites explicitados</h3><ul>${gaps}</ul></div><div class="disclaimer"><div class="note"><strong>Tendência</strong><br>${escapeHtml(scorecard.trendDisclaimer)}</div><div class="note"><strong>SLA</strong><br>${escapeHtml(scorecard.syntheticSlaDisclaimer)}</div></div><footer class="footer"><span>Quality Engineering Lab — NÃO OFICIAL | Evidências do laboratório | Decisão humana obrigatória</span><span>2/2</span></footer></section>
</body></html>`;
}
