import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from 'pdf-lib';

import type { ExecutiveScorecard, QualityStatus } from './scorecard-schema.js';
import { buildExecutiveScorecardView, type ExecutiveAttentionView, type ExecutiveScorecardView } from './scorecard-renderer.js';
import { SCORECARD_THEME, statusColor, statusSurface } from './scorecard-theme.js';

const PAGE = { width: 841.89, height: 595.28, margin: 34 } as const;
const FOOTER_LINE_1 = 'TOTVS Cloud QE Lab - Personal & Non-Official [LAB]';
const FOOTER_LINE_2 = 'Generated from deterministic Quality Engineering evidence';

function safeText(value: string): string {
  return value.replaceAll('—', '-').replaceAll('–', '-').replaceAll('->', '-');
}

function hex(value: string): ReturnType<typeof rgb> {
  const normalized = value.replace('#', '');
  return rgb(
    Number.parseInt(normalized.slice(0, 2), 16) / 255,
    Number.parseInt(normalized.slice(2, 4), 16) / 255,
    Number.parseInt(normalized.slice(4, 6), 16) / 255,
  );
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = safeText(text).replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) line = candidate;
    else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawWrapped(page: PDFPage, text: string, options: {
  x: number;
  y: number;
  width: number;
  size: number;
  lineHeight: number;
  font: PDFFont;
  color: ReturnType<typeof rgb>;
  maxLines?: number;
}): number {
  const lines = wrap(text, options.font, options.size, options.width).slice(0, options.maxLines);
  lines.forEach((line, index) => page.drawText(line, {
    x: options.x,
    y: options.y - index * options.lineHeight,
    size: options.size,
    font: options.font,
    color: options.color,
  }));
  return options.y - lines.length * options.lineHeight;
}

function drawFooter(page: PDFPage, regular: PDFFont, bold: PDFFont, pageNumber: number, totalPages: number): void {
  page.drawLine({ start: { x: PAGE.margin, y: 33 }, end: { x: PAGE.width - PAGE.margin, y: 33 }, color: hex(SCORECARD_THEME.line), thickness: 0.8 });
  page.drawText(FOOTER_LINE_1, { x: PAGE.margin, y: 20, size: 6.8, font: bold, color: hex(SCORECARD_THEME.inkSoft) });
  page.drawText(FOOTER_LINE_2, { x: PAGE.margin, y: 10.5, size: 6.2, font: regular, color: hex(SCORECARD_THEME.mutedInk) });
  page.drawText(`${pageNumber}/${totalPages}`, { x: PAGE.width - PAGE.margin - 18, y: 16, size: 7, font: bold, color: hex(SCORECARD_THEME.mutedInk) });
}

function drawHeader(page: PDFPage, regular: PDFFont, bold: PDFFont, view: ExecutiveScorecardView, label: string, title: string): void {
  page.drawRectangle({ x: 0, y: PAGE.height - 102, width: PAGE.width, height: 102, color: hex(SCORECARD_THEME.navy) });
  page.drawRectangle({ x: 0, y: PAGE.height - 102, width: 8, height: 102, color: hex(SCORECARD_THEME.cyan) });
  page.drawText(safeText(label.toUpperCase()), { x: PAGE.margin, y: PAGE.height - 31, size: 7.8, font: bold, color: hex(SCORECARD_THEME.cyanLight) });
  page.drawText(safeText(title), { x: PAGE.margin, y: PAGE.height - 60, size: 22, font: bold, color: rgb(1, 1, 1) });
  page.drawText(safeText(view.subtitle), { x: PAGE.margin, y: PAGE.height - 80, size: 9.2, font: regular, color: hex('#D9F4FA') });
  page.drawText('Personal & Non-Official [LAB]', { x: PAGE.width - PAGE.margin - 143, y: PAGE.height - 31, size: 7.2, font: regular, color: hex('#B8CAD9') });
}

function drawBadge(page: PDFPage, font: PDFFont, status: QualityStatus, label: string, x: number, y: number, width = 72): void {
  page.drawRectangle({ x, y, width, height: 18, color: hex(statusSurface(status)), borderColor: hex(statusColor(status)), borderWidth: 0.6 });
  const textWidth = font.widthOfTextAtSize(label, 7.1);
  page.drawText(label, { x: x + (width - textWidth) / 2, y: y + 5.7, size: 7.1, font, color: hex(statusColor(status)) });
}

function drawSummaryCell(page: PDFPage, regular: PDFFont, bold: PDFFont, x: number, y: number, width: number, label: string, value: string, detail: string, accent?: string): void {
  page.drawRectangle({ x, y, width, height: 62, color: rgb(1, 1, 1), borderColor: hex(SCORECARD_THEME.line), borderWidth: 0.8 });
  if (accent) page.drawRectangle({ x, y, width: 5, height: 62, color: hex(accent) });
  page.drawText(safeText(label.toUpperCase()), { x: x + 12, y: y + 45, size: 6.4, font: bold, color: hex(SCORECARD_THEME.mutedInk) });
  page.drawText(safeText(value), { x: x + 12, y: y + 24, size: 14, font: bold, color: accent ? hex(accent) : hex(SCORECARD_THEME.ink) });
  page.drawText(safeText(detail), { x: x + 12, y: y + 9, size: 6.5, font: regular, color: hex(SCORECARD_THEME.mutedInk) });
}

function drawDimensionCard(page: PDFPage, regular: PDFFont, bold: PDFFont, dimension: ExecutiveScorecardView['dimensions'][number], x: number, y: number, width: number, height: number): void {
  page.drawRectangle({ x, y, width, height, color: rgb(1, 1, 1), borderColor: hex(SCORECARD_THEME.line), borderWidth: 0.8 });
  page.drawRectangle({ x, y, width: 5, height, color: hex(statusColor(dimension.status)) });
  page.drawText(safeText(dimension.label), { x: x + 15, y: y + height - 23, size: 10.2, font: bold, color: hex(SCORECARD_THEME.ink) });
  drawBadge(page, bold, dimension.status, safeText(dimension.statusLabel), x + width - 82, y + height - 29, 68);
  page.drawText(safeText(dimension.metric), { x: x + 15, y: y + height - 49, size: 15.5, font: bold, color: hex(SCORECARD_THEME.primaryDark) });
  drawWrapped(page, dimension.interpretation, { x: x + 15, y: y + height - 66, width: width - 30, size: 7.2, lineHeight: 9, font: regular, color: hex(SCORECARD_THEME.inkSoft), maxLines: 2 });
  page.drawText(`Direção: ${safeText(dimension.trendLabel)}`, { x: x + 15, y: y + 9, size: 6.4, font: regular, color: hex(SCORECARD_THEME.mutedInk) });
}

function drawListPanel(page: PDFPage, regular: PDFFont, bold: PDFFont, title: string, items: string[], x: number, y: number, width: number, height: number, markerColor: string): void {
  page.drawRectangle({ x, y, width, height, color: rgb(1, 1, 1), borderColor: hex(SCORECARD_THEME.line), borderWidth: 0.8 });
  page.drawText(safeText(title), { x: x + 15, y: y + height - 25, size: 11.5, font: bold, color: hex(SCORECARD_THEME.ink) });
  let cursor = y + height - 48;
  for (const item of items.slice(0, 5)) {
    page.drawCircle({ x: x + 18, y: cursor + 2.5, size: 2.6, color: hex(markerColor) });
    cursor = drawWrapped(page, item.replace(/^\d+\.\s*/, ''), { x: x + 28, y: cursor + 5, width: width - 43, size: 7.4, lineHeight: 9.5, font: regular, color: hex(SCORECARD_THEME.inkSoft), maxLines: 2 }) - 8;
  }
}

function drawAttentionPanel(page: PDFPage, regular: PDFFont, bold: PDFFont, items: ExecutiveAttentionView[], x: number, y: number, width: number, height: number): void {
  page.drawRectangle({ x, y, width, height, color: rgb(1, 1, 1), borderColor: hex(SCORECARD_THEME.line), borderWidth: 0.8 });
  page.drawText('Principais Pontos de Atenção', { x: x + 15, y: y + height - 25, size: 11.5, font: bold, color: hex(SCORECARD_THEME.ink) });
  let cursor = y + height - 48;
  items.slice(0, 4).forEach((item, index) => {
    page.drawCircle({ x: x + 19, y: cursor + 2, size: 8, color: hex(SCORECARD_THEME.yellow) });
    page.drawText(String(index + 1), { x: x + 16.7, y: cursor - 0.7, size: 6.8, font: bold, color: rgb(1, 1, 1) });
    page.drawText(safeText(item.title), { x: x + 34, y: cursor + 5, size: 8.2, font: bold, color: hex(SCORECARD_THEME.ink) });
    cursor = drawWrapped(page, `Impacto: ${item.impact}`, { x: x + 34, y: cursor - 7, width: width - 49, size: 6.6, lineHeight: 8.5, font: regular, color: hex(SCORECARD_THEME.inkSoft), maxLines: 2 });
    cursor = drawWrapped(page, `Evidência: ${item.evidence}`, { x: x + 34, y: cursor - 1, width: width - 49, size: 6.1, lineHeight: 8, font: regular, color: hex(SCORECARD_THEME.mutedInk), maxLines: 2 }) - 8;
  });
}

export async function renderScorecardPdf(scorecard: ExecutiveScorecard): Promise<Uint8Array> {
  const view = buildExecutiveScorecardView(scorecard);
  const document = await PDFDocument.create();
  document.setTitle('Quality Engineering Executive Scorecard - AI-05');
  document.setSubject('[LAB] Visão executiva baseada em evidências determinísticas');
  document.setAuthor('TOTVS Cloud QE Lab - Personal & Non-Official [LAB]');
  document.setCreator('totvs-cloud-qe-lab');
  document.setProducer('pdf-lib');
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const pages = [document.addPage([PAGE.width, PAGE.height]), document.addPage([PAGE.width, PAGE.height]), document.addPage([PAGE.width, PAGE.height])];
  pages.forEach((page) => page.drawRectangle({ x: 0, y: 0, width: PAGE.width, height: PAGE.height, color: hex(SCORECARD_THEME.canvas) }));

  drawHeader(pages[0]!, regular, bold, view, 'AI-05 - Quality Engineering', view.title);
  const cellY = 414;
  const cellGap = 7;
  const cellWidths = [150, 135, 160, 125, 163];
  const cells = [
    ['Status geral', view.statusLabel, view.statusMeaning, statusColor(view.status)],
    ['Tendência', view.trendLabel, 'Leitura pontual', undefined],
    ['Data e hora', view.generatedAt, 'Horário de Brasília', undefined],
    ['Commit', view.commit, 'Referência analisada', undefined],
    ['Contexto', 'Personal & Non-Official', '[LAB]', undefined],
  ] as const;
  let cellX = PAGE.margin;
  cells.forEach((cell, index) => {
    drawSummaryCell(pages[0]!, regular, bold, cellX, cellY, cellWidths[index]!, cell[0], cell[1], cell[2], cell[3]);
    cellX += cellWidths[index]! + cellGap;
  });

  pages[0]!.drawRectangle({ x: PAGE.margin, y: 190, width: PAGE.width - PAGE.margin * 2, height: 200, color: rgb(1, 1, 1), borderColor: hex(SCORECARD_THEME.line), borderWidth: 0.8 });
  pages[0]!.drawText('LEITURA PARA DECISÃO', { x: PAGE.margin + 18, y: 364, size: 6.8, font: bold, color: hex(SCORECARD_THEME.primary) });
  pages[0]!.drawText('Resumo Executivo', { x: PAGE.margin + 18, y: 340, size: 17, font: bold, color: hex(SCORECARD_THEME.ink) });
  let summaryY = 313;
  view.executiveSummary.forEach((item) => {
    pages[0]!.drawCircle({ x: PAGE.margin + 21, y: summaryY + 3, size: 3, color: hex(SCORECARD_THEME.cyan) });
    summaryY = drawWrapped(pages[0]!, item, { x: PAGE.margin + 33, y: summaryY + 6, width: PAGE.width - PAGE.margin * 2 - 55, size: 8.8, lineHeight: 12, font: regular, color: hex(SCORECARD_THEME.inkSoft), maxLines: 2 }) - 10;
  });

  const quickWidth = (PAGE.width - PAGE.margin * 2 - 20) / 3;
  const quick = [
    ['Principal atenção', view.attention[0]?.title ?? 'Nenhuma atenção adicional', SCORECARD_THEME.yellow],
    ['Sob controle', `${scorecard.summary.controlsPassed} controles aprovados e ${scorecard.summary.controlsFailed} falhos`, SCORECARD_THEME.green],
    ['Prioridade', 'Ampliar cobertura e confiança das evidências', SCORECARD_THEME.primary],
  ] as const;
  quick.forEach((item, index) => {
    const x = PAGE.margin + index * (quickWidth + 10);
    pages[0]!.drawRectangle({ x, y: 58, width: quickWidth, height: 105, color: hex(SCORECARD_THEME.surfaceSoft), borderColor: hex(SCORECARD_THEME.line), borderWidth: 0.8 });
    pages[0]!.drawRectangle({ x, y: 58, width: 5, height: 105, color: hex(item[2]) });
    pages[0]!.drawText(item[0].toUpperCase(), { x: x + 16, y: 139, size: 6.5, font: bold, color: hex(SCORECARD_THEME.mutedInk) });
    drawWrapped(pages[0]!, item[1], { x: x + 16, y: 116, width: quickWidth - 30, size: 10.5, lineHeight: 13, font: bold, color: hex(SCORECARD_THEME.ink), maxLines: 3 });
  });

  drawHeader(pages[1]!, regular, bold, view, 'Panorama integrado', 'Visão por Dimensão');
  const cardWidth = (PAGE.width - PAGE.margin * 2 - 16) / 2;
  const cardHeight = 95;
  view.dimensions.forEach((dimension, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = PAGE.margin + column * (cardWidth + 16);
    const y = 469 - row * 102 - cardHeight;
    drawDimensionCard(pages[1]!, regular, bold, dimension, x, y, cardWidth, cardHeight);
  });

  drawHeader(pages[2]!, regular, bold, view, 'Foco de gestão', 'Atenções, controles e próximos passos');
  const panelWidth = (PAGE.width - PAGE.margin * 2 - 16) / 2;
  drawAttentionPanel(pages[2]!, regular, bold, view.attention, PAGE.margin, 284, panelWidth, 193);
  drawListPanel(pages[2]!, regular, bold, 'O que está sob controle', view.underControl, PAGE.margin + panelWidth + 16, 284, panelWidth, 193, SCORECARD_THEME.green);
  drawListPanel(pages[2]!, regular, bold, 'Ações Recomendadas', view.actions, PAGE.margin, 57, panelWidth, 209, SCORECARD_THEME.primary);
  drawListPanel(pages[2]!, regular, bold, 'Gaps e Limites Atuais', [...view.gaps, view.trendDisclaimer, view.syntheticSlaDisclaimer], PAGE.margin + panelWidth + 16, 57, panelWidth, 209, SCORECARD_THEME.yellow);

  pages.forEach((page, index) => drawFooter(page, regular, bold, index + 1, pages.length));
  return document.save({ useObjectStreams: false });
}
