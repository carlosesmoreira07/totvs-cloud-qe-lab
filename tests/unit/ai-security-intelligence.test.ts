import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AI_SECURITY_ADVISORY_UNAVAILABLE,
  buildSecurityIntelligenceContext,
  computeSecurityIntelligenceMetrics,
  formatSecurityAdvisorySummary,
  runSecurityAdvisoryAnalysis,
  type SecurityIntelligenceContext,
} from '../../tools/ai/security-intelligence.js';
import {
  parseAiSecurityAdvisory,
  type AiSecurityAdvisory,
} from '../../tools/ai/security-intelligence-schema.js';
import { createOpenAiProvider } from '../../tools/ai/openai-provider.js';
import type { AiProvider } from '../../tools/ai/provider.js';
import { scannerEvidence } from '../../tools/security/security-evidence.js';
import type { ScannerEvidence, SecurityFinding } from '../../tools/security/security-schema.js';
import { buildSecuritySummary, SECURITY_GAP_IAM_NOT_IMPLEMENTED } from '../../tools/security/security-summary.js';

const generatedAt = '2026-09-04T12:00:00.000Z';

const mediumFinding: SecurityFinding = {
  source: 'DAST',
  ruleId: '10049',
  severity: 'MEDIUM',
  subject: 'Non-Storable Content',
  location: 'http://127.0.0.1:4011',
  description: 'Resposta operacional não armazenável.',
  remediation: 'Aceito no LAB por decisão explícita.',
  status: 'ACCEPTED_LAB',
};

const criticalFinding: SecurityFinding = {
  source: 'SECRET',
  ruleId: 'SYNTHETIC_SECRET',
  severity: 'CRITICAL',
  subject: 'Possível segredo sintético',
  location: 'tests/fixtures/security/synthetic-secret.fixture.txt:1',
  description: 'Fixture sintética sem material real.',
  remediation: 'Remover e revisar antes de decisão humana.',
  status: 'OPEN',
};

function evidences(findings: SecurityFinding[] = []): ScannerEvidence[] {
  return (['SECRET', 'DEPENDENCY', 'SAST', 'DAST'] as const).map((source) => scannerEvidence({
    scanner: `${source.toLowerCase()}-scanner`,
    source,
    status: 'EXECUTED',
    target: 'local-lab',
    generatedAt,
    findings: findings.filter((finding) => finding.source === source),
  }));
}

function context(findings: SecurityFinding[] = [mediumFinding]): SecurityIntelligenceContext {
  const summary = buildSecuritySummary(evidences(findings), { generatedAt });
  return {
    purpose: 'security-intelligence-advisory',
    promptVersion: 'qe-security-advisory-v1',
    guardrails: [],
    metrics: computeSecurityIntelligenceMetrics(summary, findings),
    findings: findings.map((finding) => ({
      ...finding,
      riskId: finding.source === 'SECRET' ? 'RISK-SEC-001' : 'RISK-SEC-004',
      controlId: finding.source === 'SECRET' ? 'CTRL-SEC-SECRET-001' : 'CTRL-SEC-DAST-001',
      component: finding.source === 'DAST' ? 'api-local' : 'repository',
    })),
    gapCorrelations: [{ gapId: SECURITY_GAP_IAM_NOT_IMPLEMENTED, riskId: 'RISK-SEC-007' }],
    journeyCorrelationBasis: null,
    relatedJourneys: [],
    scorecard: null,
  };
}

const advisoryFinding = {
  subject: 'Gap IAM explícito',
  rationale: 'A cobertura de autenticação e autorização não existe no escopo atual',
  evidence: ['SECURITY_GAP_IAM_NOT_IMPLEMENTED'],
  classification: 'GAP' as const,
};

const validAdvisory: AiSecurityAdvisory = {
  executiveSummary: 'Nenhum finding crítico foi identificado nos controles executados; o gap IAM exige revisão humana.',
  topSecurityPriorities: [advisoryFinding],
  businessImpact: [],
  technicalFindings: [{
    subject: 'Finding médio aceito no LAB',
    rationale: 'O alerta passivo está registrado e possui justificativa explícita',
    evidence: ['DAST:10049', 'status=ACCEPTED_LAB'],
    classification: 'OBSERVED',
  }],
  affectedJourneys: [],
  securityGaps: [advisoryFinding],
  recommendedInvestigations: [],
  recommendedActions: [],
  humanQuestions: [advisoryFinding],
  confidence: 'HIGH',
};

test('summary válido gera métricas determinísticas sem recálculo pela IA', () => {
  const summary = buildSecuritySummary(evidences([mediumFinding]), { generatedAt });
  const metrics = computeSecurityIntelligenceMetrics(summary, [mediumFinding]);
  assert.equal(metrics.totalFindings, 1);
  assert.equal(metrics.securityStatus, 'YELLOW');
  assert.equal(metrics.controlsPassed, 4);
  assert.deepEqual(metrics.scannersExecuted, ['DAST', 'DEPENDENCY', 'SAST', 'SECRET']);
});

test('summary divergente dos findings é rejeitado antes da LLM', () => {
  const summary = buildSecuritySummary(evidences(), { generatedAt, knownGaps: [] });
  assert.throws(() => computeSecurityIntelligenceMetrics(summary, [mediumFinding]), /métricas divergentes/);
});

test('finding crítico permanece observado como CRITICAL e torna o status determinístico RED', () => {
  const summary = buildSecuritySummary(evidences([criticalFinding]), { generatedAt, knownGaps: [] });
  const metrics = computeSecurityIntelligenceMetrics(summary, [criticalFinding]);
  assert.equal(metrics.severities.CRITICAL, 1);
  assert.equal(metrics.findingsByStatus.OPEN, 1);
  assert.equal(metrics.securityStatus, 'RED');
});

test('finding médio é correlacionado à source DAST e ao componente da API local', () => {
  const summary = buildSecuritySummary(evidences([mediumFinding]), { generatedAt, knownGaps: [] });
  const metrics = computeSecurityIntelligenceMetrics(summary, [mediumFinding]);
  assert.equal(metrics.severities.MEDIUM, 1);
  assert.equal(metrics.findingsBySource.DAST, 1);
  assert.deepEqual(metrics.componentConcentrations, [{ component: 'api-local', findings: 1 }]);
});

test('gap IAM permanece explícito sem ser convertido em finding ou aprovação', () => {
  const summary = buildSecuritySummary(evidences(), { generatedAt });
  const metrics = computeSecurityIntelligenceMetrics(summary, []);
  assert.deepEqual(metrics.knownGaps, [SECURITY_GAP_IAM_NOT_IMPLEMENTED]);
  assert.equal(metrics.securityStatus, 'YELLOW');
  assert.equal(metrics.totalFindings, 0);
});

test('ausência de findings produz contagens zeradas e preserva controles executados', () => {
  const summary = buildSecuritySummary(evidences(), { generatedAt, knownGaps: [] });
  const metrics = computeSecurityIntelligenceMetrics(summary, []);
  assert.equal(metrics.totalFindings, 0);
  assert.deepEqual(metrics.componentConcentrations, []);
  assert.equal(metrics.executedControls.length, 4);
  assert.equal(metrics.securityStatus, 'GREEN');
});

test('schema aceita advisory estruturado válido', () => {
  assert.equal(parseAiSecurityAdvisory(validAdvisory).confidence, 'HIGH');
});

test('schema rejeita classificação inválida e linguagem de decisão proibida', () => {
  assert.throws(() => parseAiSecurityAdvisory({
    ...validAdvisory,
    technicalFindings: [{ ...validAdvisory.technicalFindings[0]!, classification: 'CERTAIN' }],
  }));
  assert.throws(() => parseAiSecurityAdvisory({
    ...validAdvisory,
    executiveSummary: 'O sistema está seguro.',
  }));
});

test('ausência de API key retorna fallback sem chamada externa', async () => {
  const outcome = await runSecurityAdvisoryAnalysis(createOpenAiProvider({}), context());
  assert.deepEqual(outcome, { status: AI_SECURITY_ADVISORY_UNAVAILABLE, reason: 'MISSING_API_KEY' });
  assert.match(formatSecurityAdvisorySummary(outcome), /Quality Gate não afetado/);
});

test('provider recebe schema específico e retorna advisory estruturado sem chamada real', async () => {
  const provider: AiProvider = {
    name: 'mock-provider',
    model: 'mock-model',
    analyze: async (_input, options) => {
      assert.equal(options?.schemaName, 'qe_security_advisory');
      assert.ok(options?.schema);
      assert.match(options?.instructions ?? '', /Security Intelligence/);
      return validAdvisory;
    },
  };
  const outcome = await runSecurityAdvisoryAnalysis(provider, context());
  assert.equal(outcome.status, 'AVAILABLE');
  if (outcome.status === 'AVAILABLE') assert.equal(outcome.advisory.confidence, 'HIGH');
});

test('falha do provider retorna fallback não bloqueante', async () => {
  const provider: AiProvider = {
    name: 'broken',
    model: 'mock',
    analyze: async () => { throw new Error('network failure'); },
  };
  const outcome = await runSecurityAdvisoryAnalysis(provider, context());
  assert.deepEqual(outcome, {
    status: AI_SECURITY_ADVISORY_UNAVAILABLE,
    reason: 'TIMEOUT_OR_PROVIDER_FAILURE',
  });
});

test('timeout simulado retorna fallback não bloqueante', async () => {
  const provider: AiProvider = {
    name: 'slow',
    model: 'mock',
    analyze: async () => new Promise<never>(() => undefined),
  };
  const outcome = await runSecurityAdvisoryAnalysis(provider, context(), 5);
  assert.deepEqual(outcome, {
    status: AI_SECURITY_ADVISORY_UNAVAILABLE,
    reason: 'TIMEOUT_OR_PROVIDER_FAILURE',
  });
});

test('contexto real usa apenas findings normalizados, métricas, jornadas resumidas e recorte do scorecard', () => {
  const built = buildSecurityIntelligenceContext();
  assert.equal(built.purpose, 'security-intelligence-advisory');
  assert.equal(built.metrics.totalFindings, 1);
  assert.equal(built.findings[0]?.riskId, 'RISK-SEC-004');
  assert.equal(built.findings[0]?.controlId, 'CTRL-SEC-DAST-001');
  assert.deepEqual(built.gapCorrelations, [{
    gapId: SECURITY_GAP_IAM_NOT_IMPLEMENTED,
    riskId: 'RISK-SEC-007',
  }]);
  assert.match(built.journeyCorrelationBasis ?? '', /INFERRED_CANDIDATES/);
  assert.equal(built.scorecard?.securityStatus, 'YELLOW');
  assert.ok(built.relatedJourneys.length >= 4);
});
