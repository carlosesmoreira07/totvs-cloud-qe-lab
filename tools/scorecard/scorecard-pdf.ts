import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from 'pdf-lib';

import type { ExecutiveScorecard, QualityStatus } from './scorecard-schema.js';
import { SCORECARD_THEME, statusColor } from './scorecard-theme.js';

const PAGE = { width: 841.89, height: 595.28, margin: 34 } as const;
const FOOTER = 'Quality Engineering Lab — NÃO OFICIAL | Evidências do laboratório | Decisão humana obrigatória';

function hex(value: string): ReturnType<typeof rgb> {
  const normalized = value.replace('#', '');
  return rgb(
    Number.parseInt(normalized.slice(0, 2), 16) / 255,
    Number.parseInt(normalized.slice(2, 4), 16) / 255,
    Number.parseInt(normalized.slice(4, 6), 16) / 255,
  );
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawFooter(page: PDFPage, font: PDFFont, pageNumber: number, totalPages: number): void {
  page.drawLine({
    start: { x: PAGE.margin, y: 30 },
    end: { x: PAGE.width - PAGE.margin, y: 30 },
    color: hex(SCORECARD_THEME.line),
    thickness: 0.8,
  });
  page.drawText(FOOTER, {
    x: PAGE.margin,
    y: 16,
    size: 7.4,
    font,
    color: hex(SCORECARD_THEME.mutedInk),
  });
  page.drawText(`${pageNumber}/${totalPages}`, {
    x: PAGE.width - PAGE.margin - 20,
    y: 16,
    size: 7.4,
    font,
    color: hex(SCORECARD_THEME.mutedInk),
  });
}

function drawHeader(page: PDFPage, regular: PDFFont, bold: PDFFont, scorecard: ExecutiveScorecard, subtitle: string): void {
  page.drawRectangle({ x: 0, y: PAGE.height - 112, width: PAGE.width, height: 112, color: hex(SCORECARD_THEME.ink) });
  page.drawRectangle({ x: 0, y: PAGE.height - 112, width: 9, height: 112, color: hex(SCORECARD_THEME.accent) });
  page.drawText('EXECUTIVE QUALITY SCORECARD', {
    x: PAGE.margin,
    y: PAGE.height - 46,
    size: 21,
    font: bold,
    color: rgb(1, 1, 1),
  });
  page.drawText(subtitle, {
    x: PAGE.margin,
    y: PAGE.height - 69,
    size: 10,
    font: regular,
    color: hex('#CFEAF0'),
  });
  page.drawText(`Ref ${scorecard.commit} · ${new Date(scorecard.generatedAt).toISOString().slice(0, 10)}`, {
    x: PAGE.margin,
    y: PAGE.height - 91,
    size: 8,
    font: regular,
    color: hex('#AEBBCD'),
  });
}

function drawStatusPill(page: PDFPage, font: PDFFont, status: QualityStatus, x: number, y: number): void {
  const color = hex(statusColor(status));
  page.drawRectangle({ x, y, width: 68, height: 20, borderColor: color, borderWidth: 1, color: rgb(1, 1, 1) });
  page.drawText(status, { x: x + 8, y: y + 6, size: 8.5, font, color });
}

function drawDimensionCard(
  page: PDFPage,
  regular: PDFFont,
  bold: PDFFont,
  scorecard: ExecutiveScorecard,
  index: number,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const dimension = scorecard.dimensions[index];
  if (!dimension) return;
  page.drawRectangle({
    x,
    y,
    width,
    height,
    color: rgb(1, 1, 1),
    borderColor: hex(SCORECARD_THEME.line),
    borderWidth: 1,
  });
  page.drawRectangle({ x, y: y + height - 5, width, height: 5, color: hex(statusColor(dimension.status)) });
  page.drawText(dimension.label, { x: x + 14, y: y + height - 29, size: 11.5, font: bold, color: hex(SCORECARD_THEME.ink) });
  drawStatusPill(page, bold, dimension.status, x + width - 82, y + height - 35);
  page.drawText(`Tendência: ${dimension.trend}`, { x: x + 14, y: y + height - 48, size: 7.5, font: regular, color: hex(SCORECARD_THEME.mutedInk) });

  let cursor = y + height - 70;
  for (const indicator of dimension.indicators.slice(0, 3)) {
    const unit = indicator.unit ? ` ${indicator.unit}` : '';
    page.drawText(`${indicator.label}:`, { x: x + 14, y: cursor, size: 7.5, font: regular, color: hex(SCORECARD_THEME.mutedInk) });
    page.drawText(`${indicator.value}${unit}`, { x: x + width - 108, y: cursor, size: 8.3, font: bold, color: hex(statusColor(indicator.status)) });
    cursor -= 16;
  }
  const explanation = wrap(dimension.explanation, regular, 7.4, width - 28).slice(0, 3);
  cursor -= 2;
  for (const line of explanation) {
    page.drawText(line, { x: x + 14, y: cursor, size: 7.4, font: regular, color: hex(SCORECARD_THEME.ink) });
    cursor -= 11;
  }
}

export async function renderScorecardPdf(scorecard: ExecutiveScorecard): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.setTitle('Executive Quality Scorecard — AI-05');
  document.setSubject('[LAB] Evidências determinísticas de Quality Engineering');
  document.setAuthor('Quality Engineering Lab — NÃO OFICIAL');
  document.setCreator('totvs-cloud-qe-lab');
  document.setProducer('pdf-lib');
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);

  const pages = [document.addPage([PAGE.width, PAGE.height]), document.addPage([PAGE.width, PAGE.height]), document.addPage([PAGE.width, PAGE.height])];
  for (const page of pages) page.drawRectangle({ x: 0, y: 0, width: PAGE.width, height: PAGE.height, color: hex(SCORECARD_THEME.canvas) });

  drawHeader(pages[0]!, regular, bold, scorecard, 'Evidências determinísticas para decisão humana');
  pages[0]!.drawText('STATUS GERAL', { x: PAGE.margin, y: 445, size: 9, font: bold, color: hex(SCORECARD_THEME.mutedInk) });
  pages[0]!.drawText(scorecard.overallStatus, { x: PAGE.margin, y: 398, size: 36, font: bold, color: hex(statusColor(scorecard.overallStatus)) });
  pages[0]!.drawText(`Tendência pontual: ${scorecard.overallTrend}`, { x: PAGE.margin, y: 378, size: 9, font: regular, color: hex(SCORECARD_THEME.mutedInk) });

  const headline = [
    ['Riscos exercitados', `${scorecard.summary.exercisedRisks}/${scorecard.summary.knownRisks}`],
    ['Controles aprovados', String(scorecard.summary.controlsPassed)],
    ['Jornadas', `${scorecard.summary.journeysPassed}/${scorecard.summary.journeysTotal}`],
    ['SLA sintético', `${scorecard.summary.syntheticSlaMet}/${scorecard.summary.syntheticSlaTotal}`],
  ];
  headline.forEach(([label, value], index) => {
    const x = 282 + index * 130;
    pages[0]!.drawText(value!, { x, y: 414, size: 22, font: bold, color: hex(SCORECARD_THEME.ink) });
    pages[0]!.drawText(label!, { x, y: 394, size: 7.5, font: regular, color: hex(SCORECARD_THEME.mutedInk) });
  });

  const cardWidth = 370;
  drawDimensionCard(pages[0]!, regular, bold, scorecard, 1, PAGE.margin, 188, cardWidth, 156);
  drawDimensionCard(pages[0]!, regular, bold, scorecard, 2, PAGE.margin + cardWidth + 22, 188, cardWidth, 156);
  pages[0]!.drawRectangle({ x: PAGE.margin, y: 56, width: PAGE.width - PAGE.margin * 2, height: 108, color: hex('#E7F3F5'), borderColor: hex('#B8DCE1'), borderWidth: 1 });
  pages[0]!.drawText('DECISÃO HUMANA OBRIGATÓRIA', { x: PAGE.margin + 16, y: 137, size: 11, font: bold, color: hex(SCORECARD_THEME.accentDark) });
  const decisionText = 'Este scorecard sintetiza evidências do laboratório. Ele não aprova nem reprova release e não substitui a análise do Quality Engineer responsável.';
  wrap(decisionText, regular, 9, PAGE.width - PAGE.margin * 2 - 32).forEach((line, index) => {
    pages[0]!.drawText(line, { x: PAGE.margin + 16, y: 116 - index * 14, size: 9, font: regular, color: hex(SCORECARD_THEME.ink) });
  });

  drawHeader(pages[1]!, regular, bold, scorecard, 'Dimensões de qualidade e sinais observados');
  const positions = [
    [PAGE.margin, 316], [PAGE.margin + cardWidth + 22, 316],
    [PAGE.margin, 136], [PAGE.margin + cardWidth + 22, 136],
  ] as const;
  [3, 4, 5, 6].forEach((dimensionIndex, positionIndex) => {
    const position = positions[positionIndex]!;
    drawDimensionCard(pages[1]!, regular, bold, scorecard, dimensionIndex, position[0], position[1], cardWidth, 156);
  });

  drawHeader(pages[2]!, regular, bold, scorecard, 'Regressão, gaps conhecidos e rastreabilidade');
  drawDimensionCard(pages[2]!, regular, bold, scorecard, 7, PAGE.margin, 316, cardWidth, 156);
  drawDimensionCard(pages[2]!, regular, bold, scorecard, 8, PAGE.margin + cardWidth + 22, 316, cardWidth, 156);
  pages[2]!.drawText('Gaps e limites explícitos', { x: PAGE.margin, y: 282, size: 12, font: bold, color: hex(SCORECARD_THEME.ink) });
  let gapY = 260;
  for (const gap of scorecard.knownGaps.slice(0, 5)) {
    const lines = wrap(`• ${gap}`, regular, 8, PAGE.width - PAGE.margin * 2).slice(0, 2);
    for (const line of lines) {
      pages[2]!.drawText(line, { x: PAGE.margin, y: gapY, size: 8, font: regular, color: hex(SCORECARD_THEME.ink) });
      gapY -= 12;
    }
    gapY -= 3;
  }
  pages[2]!.drawRectangle({ x: PAGE.margin, y: 62, width: PAGE.width - PAGE.margin * 2, height: 88, color: rgb(1, 1, 1), borderColor: hex(SCORECARD_THEME.line), borderWidth: 1 });
  pages[2]!.drawText('Limites de interpretação', { x: PAGE.margin + 15, y: 127, size: 10, font: bold, color: hex(SCORECARD_THEME.ink) });
  [scorecard.trendDisclaimer, scorecard.syntheticSlaDisclaimer].forEach((line, index) => {
    pages[2]!.drawText(`• ${line}`, { x: PAGE.margin + 15, y: 106 - index * 20, size: 8, font: regular, color: hex(SCORECARD_THEME.mutedInk) });
  });

  pages.forEach((page, index) => drawFooter(page, regular, index + 1, pages.length));
  return document.save({ useObjectStreams: false });
}
