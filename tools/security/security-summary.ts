import type {
  ScannerEvidence,
  SecurityControl,
  SecurityFinding,
  SecuritySource,
  SecuritySummary,
} from './security-schema.js';
import { parseSecuritySummary } from './security-schema.js';

const REQUIRED_SOURCES: SecuritySource[] = ['SECRET', 'DEPENDENCY', 'SAST', 'DAST'];

const CONTROL_BY_SOURCE: Record<SecuritySource, Pick<SecurityControl, 'riskId' | 'controlId' | 'critical'>> = {
  SECRET: { riskId: 'RISK-SEC-001', controlId: 'CTRL-SEC-SECRET-001', critical: true },
  DEPENDENCY: { riskId: 'RISK-SEC-002', controlId: 'CTRL-SEC-DEPENDENCY-001', critical: true },
  SAST: { riskId: 'RISK-SEC-003', controlId: 'CTRL-SEC-SAST-001', critical: true },
  DAST: { riskId: 'RISK-SEC-004', controlId: 'CTRL-SEC-DAST-001', critical: true },
};

const EVIDENCE_BY_SOURCE: Record<SecuritySource, string> = {
  SECRET: 'evidence/security/secret-scan.json',
  DEPENDENCY: 'evidence/security/dependency-scan.json',
  SAST: 'evidence/security/sast.json',
  DAST: 'evidence/security/dast.json',
};

export const SECURITY_GAP_IAM_NOT_IMPLEMENTED = 'SECURITY_GAP_IAM_NOT_IMPLEMENTED';

function openBlockingFinding(finding: SecurityFinding): boolean {
  return finding.status === 'OPEN' && (finding.severity === 'HIGH' || finding.severity === 'CRITICAL');
}

export function buildSecuritySummary(
  evidences: ScannerEvidence[],
  options: { generatedAt?: string; knownGaps?: string[]; additionalControls?: SecurityControl[] } = {},
): SecuritySummary {
  const bySource = new Map(evidences.map((item) => [item.source, item]));
  const findings = evidences.flatMap((item) => item.findings);
  const scannerControls: SecurityControl[] = REQUIRED_SOURCES.map((source) => {
    const evidence = bySource.get(source);
    const definition = CONTROL_BY_SOURCE[source];
    const hasBlockingFinding = evidence?.findings.some(openBlockingFinding) ?? false;
    return {
      ...definition,
      result: evidence?.status !== 'EXECUTED' ? 'UNKNOWN' : hasBlockingFinding ? 'FAILED' : 'PASSED',
      evidence: EVIDENCE_BY_SOURCE[source],
    };
  });
  const controls = [...scannerControls, ...(options.additionalControls ?? [])];
  const knownGaps = options.knownGaps ?? [SECURITY_GAP_IAM_NOT_IMPLEMENTED];
  const essentialUnavailable = REQUIRED_SOURCES.some((source) => bySource.get(source)?.status !== 'EXECUTED');
  const blockingFindings = findings.filter(openBlockingFinding);
  const criticalControlFailures = controls.filter((item) => item.critical && item.result === 'FAILED');
  const blockingReasons = [
    ...blockingFindings.map((item) => `${item.source}:${item.ruleId}:${item.severity}`),
    ...criticalControlFailures.map((item) => `${item.controlId}:FAILED`),
  ].filter((item, index, values) => values.indexOf(item) === index);
  const mediumOpen = findings.some((item) => item.status === 'OPEN' && item.severity === 'MEDIUM');
  const accepted = findings.filter((item) => item.status === 'ACCEPTED_LAB').length;
  const status = blockingReasons.length > 0
    ? 'RED'
    : essentialUnavailable
      ? 'UNKNOWN'
      : mediumOpen || knownGaps.length > 0 || accepted > 0
        ? 'YELLOW'
        : 'GREEN';

  const countSeverity = (severity: SecurityFinding['severity']): number =>
    findings.filter((item) => item.severity === severity).length;
  const countOpenSeverity = (severity: SecurityFinding['severity']): number =>
    findings.filter((item) => item.status === 'OPEN' && item.severity === severity).length;

  return parseSecuritySummary({
    schemaVersion: '1.0.0',
    rulesVersion: 'security-rules-v1',
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    scope: '[LAB] Cloud Control Plane fictício e dependências deste repositório',
    decisionAuthority: 'HUMAN',
    status,
    metrics: {
      total: findings.length,
      severities: {
        INFO: countSeverity('INFO'),
        LOW: countSeverity('LOW'),
        MEDIUM: countSeverity('MEDIUM'),
        HIGH: countSeverity('HIGH'),
        CRITICAL: countSeverity('CRITICAL'),
      },
      openSeverities: {
        INFO: countOpenSeverity('INFO'),
        LOW: countOpenSeverity('LOW'),
        MEDIUM: countOpenSeverity('MEDIUM'),
        HIGH: countOpenSeverity('HIGH'),
        CRITICAL: countOpenSeverity('CRITICAL'),
      },
      open: findings.filter((item) => item.status === 'OPEN').length,
      fixed: findings.filter((item) => item.status === 'FIXED').length,
      accepted,
    },
    scannersExecuted: REQUIRED_SOURCES.filter((source) => bySource.get(source)?.status === 'EXECUTED'),
    controlsPassed: controls.filter((item) => item.result === 'PASSED').length,
    controlsFailed: controls.filter((item) => item.result === 'FAILED').length,
    controlsUnknown: controls.filter((item) => item.result === 'UNKNOWN').length,
    controls,
    knownGaps,
    blockingReasons,
  });
}

export function securityGatePassed(summary: SecuritySummary): boolean {
  return summary.status !== 'RED' && summary.status !== 'UNKNOWN';
}

export function formatSecuritySummary(summary: SecuritySummary): string {
  return [
    `Security Status: ${summary.status}`,
    `Scanners: ${summary.scannersExecuted.join(', ') || 'nenhum'}`,
    `Findings: ${summary.metrics.total} (critical=${summary.metrics.severities.CRITICAL}, high=${summary.metrics.severities.HIGH}, medium=${summary.metrics.severities.MEDIUM}, low=${summary.metrics.severities.LOW}, info=${summary.metrics.severities.INFO})`,
    `Controles: ${summary.controlsPassed} aprovados, ${summary.controlsFailed} falhos, ${summary.controlsUnknown} sem evidência`,
    `Gaps conhecidos: ${summary.knownGaps.join(', ') || 'nenhum'}`,
    'Decisão final: humana.',
  ].join('\n');
}
