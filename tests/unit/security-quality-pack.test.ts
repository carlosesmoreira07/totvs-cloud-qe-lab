import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  deduplicateFindings,
  normalizeSeverity,
  parseNpmAuditOutput,
  parseSemgrepOutput,
  parseTruffleHogOutput,
  parseZapOutput,
  scannerEvidence,
} from '../../tools/security/security-evidence.js';
import { parseSecurityFinding, parseSecuritySummary } from '../../tools/security/security-schema.js';
import {
  SECURITY_GAP_IAM_NOT_IMPLEMENTED,
  buildSecuritySummary,
  securityGatePassed,
} from '../../tools/security/security-summary.js';

const generatedAt = '2026-09-04T12:00:00.000Z';

const emptyEvidence = (source: 'SECRET' | 'DEPENDENCY' | 'SAST' | 'DAST') => scannerEvidence({
  scanner: `scanner-${source.toLowerCase()}`,
  source,
  status: 'EXECUTED',
  target: 'local fixture',
  generatedAt,
});

const completeEvidences = () => [
  emptyEvidence('SECRET'),
  emptyEvidence('DEPENDENCY'),
  emptyEvidence('SAST'),
  emptyEvidence('DAST'),
];

test('schema aceita finding normalizado completo', () => {
  const finding = parseSecurityFinding({
    source: 'SAST', ruleId: 'rule-1', severity: 'MEDIUM', subject: 'uso inseguro',
    location: 'apps/example.ts:10', description: 'descrição controlada',
    remediation: 'substituir a construção', status: 'OPEN',
  });
  assert.equal(finding.source, 'SAST');
});

test('schema rejeita enum de severidade fora do contrato', () => {
  assert.throws(() => parseSecurityFinding({
    source: 'SAST', ruleId: 'rule-1', severity: 'SEVERE', subject: 'x', location: 'x',
    description: 'x', remediation: 'x', status: 'OPEN',
  }));
});

test('normalização de severidade cobre vocabulários dos scanners', () => {
  assert.equal(normalizeSeverity('critical (4)'), 'CRITICAL');
  assert.equal(normalizeSeverity('error'), 'HIGH');
  assert.equal(normalizeSeverity('moderate'), 'MEDIUM');
  assert.equal(normalizeSeverity('low'), 'LOW');
  assert.equal(normalizeSeverity('informational'), 'INFO');
});

test('deduplicação mantém apenas uma ocorrência pela identidade comum', () => {
  const finding = parseSecurityFinding({
    source: 'DAST', ruleId: '10021', severity: 'LOW', subject: 'header',
    location: 'http://127.0.0.1:4010/health', description: 'ausente',
    remediation: 'adicionar', status: 'OPEN',
  });
  assert.equal(deduplicateFindings([finding, finding]).length, 1);
});

test('parser TruffleHog detecta fixture sintética sem preservar o valor bruto', () => {
  const fixture = fs.readFileSync(path.resolve('tests/fixtures/security/synthetic-secret.fixture.txt'), 'utf8').trim();
  assert.match(fixture, /LAB_SYNTHETIC_SECRET=/);
  const raw = JSON.stringify({
    DetectorName: 'LabSyntheticSecret', Verified: true, Raw: fixture,
    SourceMetadata: { Data: { Filesystem: { file: 'tests/fixtures/security/synthetic-secret.fixture.txt', line: 2 } } },
  });
  const [finding] = parseTruffleHogOutput(raw);
  assert.equal(finding?.severity, 'CRITICAL');
  assert.doesNotMatch(JSON.stringify(finding), /LAB_ONLY_NOT_A_REAL_CREDENTIAL/);
});

test('parser npm audit converte advisory em finding de dependência', () => {
  const [finding] = parseNpmAuditOutput(JSON.stringify({
    vulnerabilities: {
      demo: { severity: 'high', range: '<2.0.0', fixAvailable: true, via: [{ source: 1, name: 'demo', severity: 'high', title: 'Demo advisory', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc' }] },
    },
  }));
  assert.deepEqual({ source: finding?.source, severity: finding?.severity, ruleId: finding?.ruleId }, {
    source: 'DEPENDENCY', severity: 'HIGH', ruleId: 'GHSA-aaaa-bbbb-cccc',
  });
});

test('parsers Semgrep e ZAP produzem o formato comum sem trechos de código ou tráfego', () => {
  const semgrep = parseSemgrepOutput(JSON.stringify({ results: [{
    check_id: 'lab.rule', path: 'apps/app.ts', start: { line: 8 },
    extra: { severity: 'WARNING', message: 'revisar construção', metadata: { remediation: 'usar API segura' }, lines: 'segredo não deve sair' },
  }] }));
  const zap = parseZapOutput(JSON.stringify({ site: [{ '@name': 'http://127.0.0.1', alerts: [{
    pluginid: '10021', riskdesc: 'Low (Medium)', name: 'Header ausente', desc: 'Header defensivo ausente',
    solution: 'Adicionar header', instances: [
      { uri: 'http://127.0.0.1:4010/health', requestHeader: 'não serializar' },
      { uri: 'http://127.0.0.1:4010/robots.txt', requestHeader: 'não serializar' },
    ],
  }] }] }));
  assert.equal(semgrep[0]?.severity, 'MEDIUM');
  assert.equal(zap[0]?.source, 'DAST');
  assert.equal(zap.length, 1);
  assert.equal(zap[0]?.location, 'http://127.0.0.1');
  assert.doesNotMatch(JSON.stringify([...semgrep, ...zap]), /segredo não deve sair|não serializar/);
});

test('resumo GREEN exige os quatro scanners e ausência de gaps', () => {
  const summary = buildSecuritySummary(completeEvidences(), { generatedAt, knownGaps: [] });
  assert.equal(summary.status, 'GREEN');
  assert.equal(securityGatePassed(summary), true);
  assert.equal(parseSecuritySummary(summary).metrics.total, 0);
});

test('gap IAM conhecido mantém Security Status YELLOW sem falhar o gate', () => {
  const summary = buildSecuritySummary(completeEvidences(), { generatedAt });
  assert.equal(summary.status, 'YELLOW');
  assert.deepEqual(summary.knownGaps, [SECURITY_GAP_IAM_NOT_IMPLEMENTED]);
  assert.equal(securityGatePassed(summary), true);
});

test('finding crítico sintético produz RED e falha determinística', () => {
  const criticalSecret = parseTruffleHogOutput(JSON.stringify({
    DetectorName: 'Synthetic', Verified: true,
    SourceMetadata: { Data: { Filesystem: { file: 'fixture', line: 1 } } },
  }));
  const evidences = completeEvidences();
  evidences[0] = scannerEvidence({
    scanner: 'fixture', source: 'SECRET', status: 'EXECUTED', target: 'fixture',
    generatedAt, findings: criticalSecret,
  });
  const summary = buildSecuritySummary(evidences, { generatedAt, knownGaps: [] });
  assert.equal(summary.status, 'RED');
  assert.equal(summary.metrics.severities.CRITICAL, 1);
  assert.equal(securityGatePassed(summary), false);
});

test('scanner essencial indisponível produz UNKNOWN e nunca sucesso implícito', () => {
  const evidences = completeEvidences();
  evidences[3] = scannerEvidence({
    scanner: 'zap', source: 'DAST', status: 'UNAVAILABLE', target: 'local',
    generatedAt, diagnostic: 'container indisponível',
  });
  const summary = buildSecuritySummary(evidences, { generatedAt, knownGaps: [] });
  assert.equal(summary.status, 'UNKNOWN');
  assert.equal(summary.controlsUnknown, 1);
  assert.equal(securityGatePassed(summary), false);
});
