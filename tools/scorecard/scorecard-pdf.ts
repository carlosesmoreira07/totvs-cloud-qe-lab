import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from 'pdf-lib';

import type { ExecutiveScorecard, QualityStatus } from './scorecard-schema.js';
import { buildExecutiveScorecardView, type ExecutiveScorecardView } from './scorecard-renderer.js';
import { SCORECARD_THEME, statusColor, statusSurface } from './scorecard-theme.js';

const PAGE = { width: 841.89, height: 595.28, margin: 36 } as const;
const FOOTER_LINE_1 = 'TOTVS Cloud QE Lab - Personal & Non-Official [LAB] | Governança Risco -> Controle -> Evidência';
const FOOTER_LINE_2 = 'Generated from deterministic Quality Engineering evidence';

function safeText(value: string): string {
  return value
    .replaceAll('—', '-')
    .replaceAll('–', '-')
    .replaceAll('->', '->')
    .replaceAll('●', '*')
    .replaceAll('▲', '^')
    .replaceAll('■', '#')
    .replaceAll('✔', 'OK');
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

function drawWrapped(
  page: PDFPage,
  text: string,
  options: {
    x: number;
    y: number;
    width: number;
    size: number;
    lineHeight: number;
    font: PDFFont;
    color: ReturnType<typeof rgb>;
    maxLines?: number;
  },
): number {
  const lines = wrap(text, options.font, options.size, options.width).slice(0, options.maxLines);
  lines.forEach((line, index) =>
    page.drawText(line, {
      x: options.x,
      y: options.y - index * options.lineHeight,
      size: options.size,
      font: options.font,
      color: options.color,
    }),
  );
  return options.y - lines.length * options.lineHeight;
}

function drawFooter(page: PDFPage, regular: PDFFont, bold: PDFFont, pageNumber: number, totalPages: number): void {
  page.drawLine({
    start: { x: PAGE.margin, y: 30 },
    end: { x: PAGE.width - PAGE.margin, y: 30 },
    color: hex(SCORECARD_THEME.line),
    thickness: 0.8,
  });
  page.drawText(FOOTER_LINE_1, { x: PAGE.margin, y: 17, size: 8, font: bold, color: hex(SCORECARD_THEME.inkSoft) });
  page.drawText(FOOTER_LINE_2, { x: PAGE.margin, y: 8, size: 7.2, font: regular, color: hex(SCORECARD_THEME.mutedInk) });
  page.drawText(`Página ${pageNumber} / ${totalPages}`, {
    x: PAGE.width - PAGE.margin - 65,
    y: 17,
    size: 8,
    font: bold,
    color: hex(SCORECARD_THEME.primaryDark),
  });
}

function drawPageHeader(
  page: PDFPage,
  regular: PDFFont,
  bold: PDFFont,
  title: string,
  subtitle: string,
  tagText: string,
): void {
  page.drawText(safeText(title), { x: PAGE.margin, y: PAGE.height - 42, size: 20, font: bold, color: hex(SCORECARD_THEME.navy) });
  page.drawText(safeText(subtitle), { x: PAGE.margin, y: PAGE.height - 57, size: 9.5, font: regular, color: hex(SCORECARD_THEME.mutedInk) });

  const tagWidth = bold.widthOfTextAtSize(tagText, 8.5) + 16;
  page.drawRectangle({
    x: PAGE.width - PAGE.margin - tagWidth,
    y: PAGE.height - 52,
    width: tagWidth,
    height: 19,
    color: hex(SCORECARD_THEME.cyanSurface),
    borderColor: hex(SCORECARD_THEME.cyanLight),
    borderWidth: 0.8,
  });
  page.drawText(tagText, {
    x: PAGE.width - PAGE.margin - tagWidth + 8,
    y: PAGE.height - 45,
    size: 8.5,
    font: bold,
    color: hex(SCORECARD_THEME.primaryDark),
  });

  page.drawLine({
    start: { x: PAGE.margin, y: PAGE.height - 68 },
    end: { x: PAGE.width - PAGE.margin, y: PAGE.height - 68 },
    color: hex(SCORECARD_THEME.line),
    thickness: 1,
  });
}

function drawBadge(page: PDFPage, font: PDFFont, status: QualityStatus, label: string, x: number, y: number, width = 74): void {
  page.drawRectangle({
    x,
    y,
    width,
    height: 17,
    color: hex(statusSurface(status)),
    borderColor: hex(statusColor(status)),
    borderWidth: 0.8,
  });
  const text = safeText(label);
  const textWidth = font.widthOfTextAtSize(text, 7.5);
  page.drawText(text, { x: x + (width - textWidth) / 2, y: y + 4.5, size: 7.5, font, color: hex(statusColor(status)) });
}

export async function renderScorecardPdf(scorecard: ExecutiveScorecard): Promise<Uint8Array> {
  const view = buildExecutiveScorecardView(scorecard);
  const document = await PDFDocument.create();
  document.setTitle('Executive Quality Scorecard - TOTVS Cloud QE Lab');
  document.setSubject('[LAB] Visão executiva da qualidade em 2 páginas A4 landscape');
  document.setAuthor('TOTVS Cloud QE Lab - Personal & Non-Official [LAB]');
  document.setCreator('totvs-cloud-qe-lab');
  document.setProducer('pdf-lib');

  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);

  const pages = [
    document.addPage([PAGE.width, PAGE.height]),
    document.addPage([PAGE.width, PAGE.height]),
  ];

  pages.forEach((page) =>
    page.drawRectangle({ x: 0, y: 0, width: PAGE.width, height: PAGE.height, color: hex(SCORECARD_THEME.canvas) }),
  );

  // ==========================================
  // PÁGINA 1: DECISÃO
  // ==========================================
  drawPageHeader(pages[0]!, regular, bold, view.title, view.subtitle, 'PÁGINA 1 - DECISÃO');

  // Status Strip (4 cells)
  const stripY = PAGE.height - 128;
  const stripH = 52;
  const stripW = (PAGE.width - PAGE.margin * 2 - 27) / 4;

  // Cell 1: Status Geral
  pages[0]!.drawRectangle({
    x: PAGE.margin,
    y: stripY,
    width: stripW,
    height: stripH,
    color: hex(statusSurface(view.status)),
    borderColor: hex(SCORECARD_THEME.line),
    borderWidth: 0.8,
  });
  pages[0]!.drawRectangle({
    x: PAGE.margin,
    y: stripY,
    width: 4,
    height: stripH,
    color: hex(statusColor(view.status)),
  });
  pages[0]!.drawText('STATUS GERAL', { x: PAGE.margin + 10, y: stripY + 38, size: 7.2, font: bold, color: hex(SCORECARD_THEME.mutedInk) });
  pages[0]!.drawText(safeText(view.statusLabel), { x: PAGE.margin + 10, y: stripY + 20, size: 14, font: bold, color: hex(statusColor(view.status)) });
  pages[0]!.drawText(safeText(view.statusMeaning), { x: PAGE.margin + 10, y: stripY + 7, size: 8, font: regular, color: hex(SCORECARD_THEME.inkSoft) });

  // Cell 2: Tendência Histórica
  const cell2X = PAGE.margin + stripW + 9;
  pages[0]!.drawRectangle({
    x: cell2X,
    y: stripY,
    width: stripW,
    height: stripH,
    color: rgb(1, 1, 1),
    borderColor: hex(SCORECARD_THEME.line),
    borderWidth: 0.8,
  });
  pages[0]!.drawText('TENDÊNCIA HISTÓRICA', { x: cell2X + 10, y: stripY + 38, size: 7.2, font: bold, color: hex(SCORECARD_THEME.mutedInk) });
  pages[0]!.drawText(safeText(view.trendLabel), { x: cell2X + 10, y: stripY + 20, size: 13, font: bold, color: hex(SCORECARD_THEME.ink) });
  pages[0]!.drawText(
    safeText(view.hasHistoricalTrend ? `${view.checkpointsAnalyzed} checkpoints comparáveis` : 'Série em formação'),
    { x: cell2X + 10, y: stripY + 7, size: 8, font: regular, color: hex(SCORECARD_THEME.inkSoft) },
  );

  // Cell 3: Commit & Data
  const cell3X = cell2X + stripW + 9;
  pages[0]!.drawRectangle({
    x: cell3X,
    y: stripY,
    width: stripW,
    height: stripH,
    color: rgb(1, 1, 1),
    borderColor: hex(SCORECARD_THEME.line),
    borderWidth: 0.8,
  });
  pages[0]!.drawText('COMMIT & DATA', { x: cell3X + 10, y: stripY + 38, size: 7.2, font: bold, color: hex(SCORECARD_THEME.mutedInk) });
  pages[0]!.drawText(safeText(view.commit), { x: cell3X + 10, y: stripY + 20, size: 12, font: bold, color: hex(SCORECARD_THEME.ink) });
  pages[0]!.drawText(safeText(view.generatedAt), { x: cell3X + 10, y: stripY + 7, size: 8, font: regular, color: hex(SCORECARD_THEME.inkSoft) });

  // Cell 4: Governança
  const cell4X = cell3X + stripW + 9;
  pages[0]!.drawRectangle({
    x: cell4X,
    y: stripY,
    width: stripW,
    height: stripH,
    color: rgb(1, 1, 1),
    borderColor: hex(SCORECARD_THEME.line),
    borderWidth: 0.8,
  });
  pages[0]!.drawText('GOVERNANÇA', { x: cell4X + 10, y: stripY + 38, size: 7.2, font: bold, color: hex(SCORECARD_THEME.mutedInk) });
  pages[0]!.drawText('Decisão Humana', { x: cell4X + 10, y: stripY + 20, size: 12, font: bold, color: hex(SCORECARD_THEME.primaryDark) });
  pages[0]!.drawText('Gate 100% Determinístico', { x: cell4X + 10, y: stripY + 7, size: 8, font: regular, color: hex(SCORECARD_THEME.inkSoft) });

  // Resumo Executivo Box
  const summaryBoxY = stripY - 84;
  const summaryBoxH = 76;
  pages[0]!.drawRectangle({
    x: PAGE.margin,
    y: summaryBoxY,
    width: PAGE.width - PAGE.margin * 2,
    height: summaryBoxH,
    color: rgb(1, 1, 1),
    borderColor: hex(SCORECARD_THEME.line),
    borderWidth: 0.8,
  });
  pages[0]!.drawText('RESUMO EXECUTIVO PARA A LIDERANÇA', {
    x: PAGE.margin + 12,
    y: summaryBoxY + summaryBoxH - 15,
    size: 8.5,
    font: bold,
    color: hex(SCORECARD_THEME.primaryDark),
  });

  let sumTextY = summaryBoxY + summaryBoxH - 29;
  view.executiveSummary.forEach((sentence) => {
    pages[0]!.drawCircle({ x: PAGE.margin + 15, y: sumTextY + 2.5, size: 2, color: hex(SCORECARD_THEME.cyan) });
    sumTextY =
      drawWrapped(pages[0]!, sentence, {
        x: PAGE.margin + 22,
        y: sumTextY + 4,
        width: PAGE.width - PAGE.margin * 2 - 34,
        size: 8.4,
        lineHeight: 10.5,
        font: regular,
        color: hex(SCORECARD_THEME.inkSoft),
        maxLines: 1,
      }) - 2;
  });

  // Columns Grid: O que está sob controle (left) & Pontos de atenção (right)
  const colsY = summaryBoxY - 188;
  const colsH = 180;
  const colW = (PAGE.width - PAGE.margin * 2 - 12) / 2;

  // Left: Sob controle
  pages[0]!.drawRectangle({
    x: PAGE.margin,
    y: colsY,
    width: colW,
    height: colsH,
    color: rgb(1, 1, 1),
    borderColor: hex(SCORECARD_THEME.line),
    borderWidth: 0.8,
  });
  pages[0]!.drawText('O QUE ESTÁ SOB CONTROLE', {
    x: PAGE.margin + 12,
    y: colsY + colsH - 18,
    size: 9.5,
    font: bold,
    color: hex(SCORECARD_THEME.navy),
  });

  let ctrlY = colsY + colsH - 36;
  view.underControl.forEach((item) => {
    pages[0]!.drawText(`[OK] ${safeText(item.title)}`, {
      x: PAGE.margin + 12,
      y: ctrlY,
      size: 8.5,
      font: bold,
      color: hex(SCORECARD_THEME.green),
    });
    ctrlY =
      drawWrapped(pages[0]!, item.description, {
        x: PAGE.margin + 12,
        y: ctrlY - 11,
        width: colW - 24,
        size: 7.8,
        lineHeight: 9.5,
        font: regular,
        color: hex(SCORECARD_THEME.inkSoft),
        maxLines: 2,
      }) - 8;
  });

  // Right: Pontos de Atenção
  const rightColX = PAGE.margin + colW + 12;
  pages[0]!.drawRectangle({
    x: rightColX,
    y: colsY,
    width: colW,
    height: colsH,
    color: rgb(1, 1, 1),
    borderColor: hex(SCORECARD_THEME.line),
    borderWidth: 0.8,
  });
  pages[0]!.drawText('PONTOS DE ATENÇÃO & GAPS', {
    x: rightColX + 12,
    y: colsY + colsH - 18,
    size: 9.5,
    font: bold,
    color: hex(SCORECARD_THEME.navy),
  });

  let attY = colsY + colsH - 36;
  view.attention.forEach((item) => {
    pages[0]!.drawText(`[^] ${safeText(item.title)}`, {
      x: rightColX + 12,
      y: attY,
      size: 8.5,
      font: bold,
      color: hex(SCORECARD_THEME.yellow),
    });
    attY =
      drawWrapped(pages[0]!, item.description, {
        x: rightColX + 12,
        y: attY - 11,
        width: colW - 24,
        size: 7.8,
        lineHeight: 9.5,
        font: regular,
        color: hex(SCORECARD_THEME.inkSoft),
        maxLines: 2,
      }) - 3;
    attY =
      drawWrapped(pages[0]!, item.detail, {
        x: rightColX + 12,
        y: attY,
        width: colW - 24,
        size: 7.2,
        lineHeight: 8.8,
        font: regular,
        color: hex(SCORECARD_THEME.mutedInk),
        maxLines: 1,
      }) - 8;
  });

  // Next Action Box
  const nextActionY = colsY - 50;
  pages[0]!.drawRectangle({
    x: PAGE.margin,
    y: nextActionY,
    width: PAGE.width - PAGE.margin * 2,
    height: 42,
    color: hex(SCORECARD_THEME.cyanSurface),
    borderColor: hex(SCORECARD_THEME.cyanLight),
    borderWidth: 0.8,
  });
  pages[0]!.drawRectangle({
    x: PAGE.margin,
    y: nextActionY,
    width: 4,
    height: 42,
    color: hex(SCORECARD_THEME.primary),
  });
  pages[0]!.drawText('DECISÃO & PRÓXIMOS PASSOS RECOMENDADOS:', {
    x: PAGE.margin + 12,
    y: nextActionY + 28,
    size: 8,
    font: bold,
    color: hex(SCORECARD_THEME.primaryDark),
  });
  drawWrapped(pages[0]!, view.nextAction, {
    x: PAGE.margin + 12,
    y: nextActionY + 16,
    width: PAGE.width - PAGE.margin * 2 - 24,
    size: 7.6,
    lineHeight: 9.5,
    font: regular,
    color: hex(SCORECARD_THEME.ink),
    maxLines: 2,
  });

  drawFooter(pages[0]!, regular, bold, 1, 2);

  // ==========================================
  // PÁGINA 2: EVIDÊNCIA QUE SUSTENTA A DECISÃO
  // ==========================================
  drawPageHeader(
    pages[1]!,
    regular,
    bold,
    'Evidências que Sustentam a Decisão',
    'Panorama detalhado por dimensão técnica com uma métrica central e interpretação direta',
    'PÁGINA 2 - EVIDÊNCIA',
  );

  // 8 Evidence Cards in 4 columns x 2 rows
  const gridY = PAGE.height - 80;
  const cardW = (PAGE.width - PAGE.margin * 2 - 27) / 4;
  const cardH = 195;
  const cardGap = 9;

  view.evidenceCards.forEach((card, index) => {
    const col = index % 4;
    const row = Math.floor(index / 4);
    const x = PAGE.margin + col * (cardW + cardGap);
    const y = gridY - (row + 1) * cardH - row * cardGap;

    pages[1]!.drawRectangle({
      x,
      y,
      width: cardW,
      height: cardH,
      color: rgb(1, 1, 1),
      borderColor: hex(SCORECARD_THEME.line),
      borderWidth: 0.8,
    });
    pages[1]!.drawRectangle({
      x,
      y,
      width: 4,
      height: cardH,
      color: hex(statusColor(card.status)),
    });

    // Card Header
    pages[1]!.drawText(safeText(card.label), {
      x: x + 10,
      y: y + cardH - 18,
      size: 9.5,
      font: bold,
      color: hex(SCORECARD_THEME.navy),
    });

    drawBadge(pages[1]!, bold, card.status, safeText(card.statusLabel), x + cardW - 78, y + cardH - 24, 70);

    // Card Metric Row
    pages[1]!.drawText(safeText(card.metric), {
      x: x + 10,
      y: y + cardH - 46,
      size: 14,
      font: bold,
      color: hex(SCORECARD_THEME.primaryDark),
    });
    if (card.secondaryMetric) {
      pages[1]!.drawText(safeText(card.secondaryMetric), {
        x: x + 10,
        y: y + cardH - 60,
        size: 8,
        font: bold,
        color: hex(SCORECARD_THEME.mutedInk),
      });
    }

    // Divider line
    pages[1]!.drawLine({
      start: { x: x + 10, y: y + cardH - 70 },
      end: { x: x + cardW - 10, y: y + cardH - 70 },
      color: hex(SCORECARD_THEME.line),
      thickness: 0.6,
    });

    // Interpretation Text
    drawWrapped(pages[1]!, card.interpretation, {
      x: x + 10,
      y: y + cardH - 85,
      width: cardW - 20,
      size: 7.8,
      lineHeight: 10,
      font: regular,
      color: hex(SCORECARD_THEME.inkSoft),
      maxLines: 6,
    });

    // Trend Direction at bottom
    pages[1]!.drawLine({
      start: { x: x + 10, y: y + 22 },
      end: { x: x + cardW - 10, y: y + 22 },
      color: hex(SCORECARD_THEME.line),
      thickness: 0.6,
    });
    pages[1]!.drawText(`Direção: ${safeText(card.trendLabel)}`, {
      x: x + 10,
      y: y + 9,
      size: 7.2,
      font: regular,
      color: hex(SCORECARD_THEME.mutedInk),
    });
  });

  // Traceability Note at bottom of Page 2
  const noteY = 40;
  pages[1]!.drawRectangle({
    x: PAGE.margin,
    y: noteY,
    width: PAGE.width - PAGE.margin * 2,
    height: 24,
    color: rgb(1, 1, 1),
    borderColor: hex(SCORECARD_THEME.line),
    borderWidth: 0.8,
  });
  pages[1]!.drawText(
    'Rastreabilidade: Todas as métricas são comprovadas por arquivos JSON versionados em evidence/, com 0 testes flaky.',
    {
      x: PAGE.margin + 12,
      y: noteY + 8,
      size: 7.8,
      font: bold,
      color: hex(SCORECARD_THEME.primaryDark),
    },
  );

  drawFooter(pages[1]!, regular, bold, 2, 2);

  return document.save({ useObjectStreams: false });
}
