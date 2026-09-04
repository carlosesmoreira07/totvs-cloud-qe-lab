import { z } from 'zod';

export const securitySourceSchema = z.enum(['SAST', 'DAST', 'DEPENDENCY', 'SECRET']);
export const securitySeveritySchema = z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export const securityFindingStatusSchema = z.enum(['OPEN', 'ACCEPTED_LAB', 'FIXED', 'NOT_APPLICABLE']);
export const scannerStatusSchema = z.enum(['EXECUTED', 'UNAVAILABLE', 'FAILED']);
export const controlResultSchema = z.enum(['PASSED', 'FAILED', 'UNKNOWN']);
export const securityStatusSchema = z.enum(['GREEN', 'YELLOW', 'RED', 'UNKNOWN']);

export const securityFindingSchema = z.object({
  source: securitySourceSchema,
  ruleId: z.string().min(1).max(200),
  severity: securitySeveritySchema,
  subject: z.string().min(1).max(300),
  location: z.string().min(1).max(500),
  description: z.string().min(1).max(2_000),
  remediation: z.string().min(1).max(2_000),
  status: securityFindingStatusSchema,
}).strict();

export const scannerEvidenceSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  generatedAt: z.string().datetime(),
  scanner: z.string().min(1),
  source: securitySourceSchema,
  status: scannerStatusSchema,
  target: z.string().min(1),
  findings: z.array(securityFindingSchema),
  diagnostic: z.string().min(1).max(500).optional(),
}).strict();

export const securityControlSchema = z.object({
  riskId: z.string().regex(/^RISK-SEC-\d{3}$/),
  controlId: z.string().min(1),
  result: controlResultSchema,
  evidence: z.string().min(1),
  critical: z.boolean(),
}).strict();

export const securitySummarySchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  rulesVersion: z.literal('security-rules-v1'),
  generatedAt: z.string().datetime(),
  scope: z.literal('[LAB] Cloud Control Plane fictício e dependências deste repositório'),
  decisionAuthority: z.literal('HUMAN'),
  status: securityStatusSchema,
  metrics: z.object({
    total: z.number().int().nonnegative(),
    severities: z.object({
      INFO: z.number().int().nonnegative(),
      LOW: z.number().int().nonnegative(),
      MEDIUM: z.number().int().nonnegative(),
      HIGH: z.number().int().nonnegative(),
      CRITICAL: z.number().int().nonnegative(),
    }).strict(),
    openSeverities: z.object({
      INFO: z.number().int().nonnegative(),
      LOW: z.number().int().nonnegative(),
      MEDIUM: z.number().int().nonnegative(),
      HIGH: z.number().int().nonnegative(),
      CRITICAL: z.number().int().nonnegative(),
    }).strict(),
    open: z.number().int().nonnegative(),
    fixed: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
  }).strict(),
  scannersExecuted: z.array(securitySourceSchema),
  controlsPassed: z.number().int().nonnegative(),
  controlsFailed: z.number().int().nonnegative(),
  controlsUnknown: z.number().int().nonnegative(),
  controls: z.array(securityControlSchema),
  knownGaps: z.array(z.string().min(1)),
  blockingReasons: z.array(z.string().min(1)),
}).strict();

export type SecuritySource = z.infer<typeof securitySourceSchema>;
export type SecuritySeverity = z.infer<typeof securitySeveritySchema>;
export type SecurityFinding = z.infer<typeof securityFindingSchema>;
export type ScannerEvidence = z.infer<typeof scannerEvidenceSchema>;
export type SecurityControl = z.infer<typeof securityControlSchema>;
export type SecuritySummary = z.infer<typeof securitySummarySchema>;

export function parseSecurityFinding(value: unknown): SecurityFinding {
  return securityFindingSchema.parse(value);
}

export function parseScannerEvidence(value: unknown): ScannerEvidence {
  return scannerEvidenceSchema.parse(value);
}

export function parseSecuritySummary(value: unknown): SecuritySummary {
  return securitySummarySchema.parse(value);
}
