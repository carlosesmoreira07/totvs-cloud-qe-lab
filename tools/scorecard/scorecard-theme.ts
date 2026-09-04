import type { QualityStatus } from './scorecard-schema.js';

/**
 * [LAB] Paleta própria inspirada em páginas públicas de tecnologia/cloud da TOTVS.
 * Não reproduz identidade corporativa e não utiliza logotipos ou ativos proprietários.
 */
export const SCORECARD_THEME = {
  navy: '#0B1F3A',
  ink: '#102A43',
  inkSoft: '#27445F',
  mutedInk: '#5D7185',
  surface: '#FFFFFF',
  surfaceSoft: '#F5F9FC',
  canvas: '#EEF4F8',
  line: '#D4E1EA',
  primary: '#087CC1',
  primaryDark: '#07568E',
  accent: '#0A9FBB',
  accentDark: '#086B80',
  cyan: '#18B7D1',
  cyanLight: '#A9EDF6',
  cyanSurface: '#E8F8FB',
  green: '#167A55',
  greenSurface: '#E6F5ED',
  yellow: '#9A6400',
  yellowSurface: '#FFF3D6',
  red: '#B42318',
  redSurface: '#FDECEA',
  unknown: '#667586',
  unknownSurface: '#E9EEF3',
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
