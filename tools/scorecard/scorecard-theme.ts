import type { QualityStatus } from './scorecard-schema.js';

/**
 * [LAB] Paleta própria inspirada em páginas públicas de tecnologia/cloud da TOTVS.
 * Não reproduz identidade corporativa e não utiliza logotipos ou ativos proprietários.
 */
export const SCORECARD_THEME = {
  ink: '#17243D',
  mutedInk: '#5C687C',
  surface: '#FFFFFF',
  canvas: '#F2F6F9',
  line: '#D9E2E9',
  accent: '#00A7B5',
  accentDark: '#086A78',
  green: '#137A55',
  greenSurface: '#E4F4EC',
  yellow: '#966400',
  yellowSurface: '#FFF2CC',
  red: '#B42318',
  redSurface: '#FDE8E6',
  unknown: '#626B78',
  unknownSurface: '#E9EDF1',
} as const;

export function statusColor(status: QualityStatus): string {
  if (status === 'GREEN') return SCORECARD_THEME.green;
  if (status === 'YELLOW') return SCORECARD_THEME.yellow;
  if (status === 'RED') return SCORECARD_THEME.red;
  return SCORECARD_THEME.unknown;
}

export function statusSurface(status: QualityStatus): string {
  if (status === 'GREEN') return SCORECARD_THEME.greenSurface;
  if (status === 'YELLOW') return SCORECARD_THEME.yellowSurface;
  if (status === 'RED') return SCORECARD_THEME.redSurface;
  return SCORECARD_THEME.unknownSurface;
}
