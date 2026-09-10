import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AI_ADVISORY_UNAVAILABLE,
  buildAdvisoryContext,
  formatAdvisorySummary,
  runAdvisoryAnalysis,
} from '../../tools/ai/advisory-analysis.js';
import { createOpenAiProvider, OpenAiProvider } from '../../tools/ai/openai-provider.js';
import { UnavailableAiProvider, type AiProvider } from '../../tools/ai/provider.js';
import { parseAiAdvisory, type AiAdvisory } from '../../tools/ai/schema.js';
import { detectOpenApiChangeNature } from '../../tools/impact-context.js';
import type { ImpactContext } from '../../tools/impact-context.js';

const validAdvisory: AiAdvisory = {
  changeSummary: 'Fluxo de retry alterado em store.ts: timeout reduzido de 5s para 3s.',
  changeNature: 'BEHAVIOR',
  impact: 'MEDIUM',
  impactedRisks: [{
    subject: 'RISK-API-005',
    rationale: 'O fluxo de retry foi alterado',
    evidence: ['apps/control-plane-mock/src/store.ts'],
  }],
  impactedControls: [],
  coverageGaps: [],
  suspiciousTests: [],
  securityConcerns: [],
  recommendedChecks: [],
  humanQuestions: [{
    subject: 'Revisar conflito',
    rationale: 'Confirmar a semântica para payload divergente',
    evidence: ['specs/openapi/cloud-control-plane.yaml'],
  }],
  confidence: 'HIGH',
};

const changes: ImpactContext = {
  generatedBy: 'deterministic-impact-context',
  decisionAuthority: 'human',
  changedFiles: ['apps/control-plane-mock/src/store.ts'],
  candidateRisks: ['duplicidade'],
  candidateControls: ['npm run test:api'],
  humanQuestions: ['O retry permanece idempotente?'],
  knownRiskControls: [],
  relevantDiffs: [],
  openApiChanged: false,
  openApiChangeNature: 'UNKNOWN',
  openApiDiff: null,
  limits: {
    maxDiffFiles: 12,
    maxCharsPerFile: 2_800,
    maxTotalDiffChars: 16_000,
    excludedSensitiveFileCount: 0,
  },
};

const context = buildAdvisoryContext(changes, {
  source: 'playwright-json',
  total: 1,
  passed: 1,
  failed: 0,
  flaky: 0,
  skipped: 0,
  durationMs: 10,
  controls: [{ name: 'retry sequencial', status: 'passed' }],
});

test('aceita advisory que obedece ao schema (inclui changeSummary e changeNature)', () => {
  assert.deepEqual(parseAiAdvisory(validAdvisory), validAdvisory);
});

test('rejeita advisory sem changeSummary', () => {
  const { changeSummary: _, ...withoutSummary } = validAdvisory;
  assert.throws(() => parseAiAdvisory(withoutSummary));
});

test('rejeita advisory sem changeNature', () => {
  const { changeNature: _, ...withoutNature } = validAdvisory;
  assert.throws(() => parseAiAdvisory(withoutNature));
});

test('adapter OpenAI aceita saída estruturada sem chamada real', async () => {
  let sentContext = '';
  const provider = new OpenAiProvider({
    apiKey: 'fake-key-for-unit-test',
    model: 'fake-structured-model',
    responseParser: async (request) => {
      sentContext = request.input;
      assert.equal(request.store, false);
      return { output_parsed: validAdvisory };
    },
  });

  const outcome = await runAdvisoryAnalysis(provider, context);
  assert.equal(outcome.status, 'AVAILABLE');
  assert.match(sentContext, /qe-advisory-v2/);
});

test('rejeita advisory com schema inválido', () => {
  assert.throws(() => parseAiAdvisory({ ...validAdvisory, impact: 'UNKNOWN' }));
});

test('provider indisponível retorna fallback consultivo', async () => {
  const outcome = await runAdvisoryAnalysis(new UnavailableAiProvider(), context);
  assert.deepEqual(outcome, {
    status: AI_ADVISORY_UNAVAILABLE,
    reason: 'PROVIDER_UNAVAILABLE',
  });
});

test('ausência de OPENAI_API_KEY retorna fallback sem chamada externa', async () => {
  const provider = createOpenAiProvider({});
  const outcome = await runAdvisoryAnalysis(provider, context);
  assert.deepEqual(outcome, {
    status: AI_ADVISORY_UNAVAILABLE,
    reason: 'MISSING_API_KEY',
  });
  const formatted = formatAdvisorySummary(outcome);
  assert.match(formatted, /AI_ADVISORY_UNAVAILABLE/);
  assert.match(formatted, /Quality Gate não afetado/);
});

test('resposta malformada da OpenAI retorna fallback', async () => {
  const provider = new OpenAiProvider({
    apiKey: 'fake-key-for-unit-test',
    responseParser: async () => ({ output_parsed: 'not-an-advisory' }),
  });
  const outcome = await runAdvisoryAnalysis(provider, context);
  assert.deepEqual(outcome, {
    status: AI_ADVISORY_UNAVAILABLE,
    reason: 'INVALID_RESPONSE',
  });
});

test('timeout simulado retorna fallback', async () => {
  const provider: AiProvider = {
    name: 'never-responds',
    model: 'fake-model',
    analyze: async () => new Promise<never>(() => undefined),
  };
  const outcome = await runAdvisoryAnalysis(provider, context, 5);
  assert.deepEqual(outcome, {
    status: AI_ADVISORY_UNAVAILABLE,
    reason: 'TIMEOUT_OR_PROVIDER_FAILURE',
  });
});

test('falha simulada do provider retorna fallback', async () => {
  const provider: AiProvider = {
    name: 'fails',
    model: 'fake-model',
    analyze: async () => { throw new Error('simulated failure'); },
  };
  const outcome = await runAdvisoryAnalysis(provider, context);
  assert.deepEqual(outcome, {
    status: AI_ADVISORY_UNAVAILABLE,
    reason: 'TIMEOUT_OR_PROVIDER_FAILURE',
  });
});

// ── Novos testes: formato compacto e openApiChangeNature ──────────────────────

test('formatAdvisorySummary: saída contém Resumo, Impacto, Confiança', () => {
  const outcome = {
    status: 'AVAILABLE' as const,
    provider: 'openai',
    model: 'gpt-4o',
    advisory: validAdvisory,
  };
  const formatted = formatAdvisorySummary(outcome);
  assert.match(formatted, /\*\*Resumo:\*\*/);
  assert.match(formatted, /\*\*Impacto:\*\* MEDIUM/);
  assert.match(formatted, /\*\*Confiança:\*\* HIGH/);
  assert.match(formatted, /AI advisory · decisão humana · Quality Gate não afetado/);
});

test('formatAdvisorySummary: NÃO inclui provedor, modelo nem prompt no output', () => {
  const outcome = {
    status: 'AVAILABLE' as const,
    provider: 'openai',
    model: 'gpt-4o',
    advisory: validAdvisory,
  };
  const formatted = formatAdvisorySummary(outcome);
  assert.doesNotMatch(formatted, /Provedor:/i);
  assert.doesNotMatch(formatted, /Modelo:/i);
  assert.doesNotMatch(formatted, /Prompt:/i);
  assert.doesNotMatch(formatted, /openai/i);
  assert.doesNotMatch(formatted, /gpt-4o/i);
});

test('formatAdvisorySummary: seções vazias não aparecem no output', () => {
  const advisoryAllEmpty: AiAdvisory = {
    ...validAdvisory,
    impactedRisks: [],
    coverageGaps: [],
    suspiciousTests: [],
    recommendedChecks: [],
    impactedControls: [],
    securityConcerns: [],
    humanQuestions: [],
  };
  const outcome = {
    status: 'AVAILABLE' as const,
    provider: 'openai',
    model: 'gpt-4o',
    advisory: advisoryAllEmpty,
  };
  const formatted = formatAdvisorySummary(outcome);
  assert.doesNotMatch(formatted, /Nenhum item/i);
  assert.doesNotMatch(formatted, /Nenhum apontamento/i);
  assert.doesNotMatch(formatted, /### /); // sem headers H3
});

test('formatAdvisorySummary: max 1 pergunta no output', () => {
  const advisoryManyQuestions: AiAdvisory = {
    ...validAdvisory,
    humanQuestions: [
      { subject: 'Q1', rationale: 'r1', evidence: [] },
      { subject: 'Q2', rationale: 'r2', evidence: [] },
      { subject: 'Q3', rationale: 'r3', evidence: [] },
    ],
  };
  const outcome = {
    status: 'AVAILABLE' as const,
    provider: 'openai',
    model: 'gpt-4o',
    advisory: advisoryManyQuestions,
  };
  const formatted = formatAdvisorySummary(outcome);
  const questionCount = (formatted.match(/\*\*Pergunta:\*\*/g) ?? []).length;
  assert.equal(questionCount, 1);
});

test('detectOpenApiChangeNature: DOCUMENTATION para diff só com summary/description', () => {
  const docOnlyDiff = `--- a/specs/openapi/cloud-control-plane.yaml
+++ b/specs/openapi/cloud-control-plane.yaml
@@ -10,7 +10,7 @@
-  summary: Consulta a saude do mock
+  summary: Consulta a saude do mock - atualizado
-  description: Retorna status ok.
+  description: Retorna status ok quando o servico esta ativo.`;

  assert.equal(detectOpenApiChangeNature(docOnlyDiff), 'DOCUMENTATION');
});

test('detectOpenApiChangeNature: SEMANTIC para diff com paths/schema', () => {
  const semanticDiff = `--- a/specs/openapi/cloud-control-plane.yaml
+++ b/specs/openapi/cloud-control-plane.yaml
@@ -20,5 +20,5 @@
-        type: string
+        type: integer
   required: true`;

  assert.equal(detectOpenApiChangeNature(semanticDiff), 'SEMANTIC');
});

test('detectOpenApiChangeNature: UNKNOWN para diff nulo', () => {
  assert.equal(detectOpenApiChangeNature(null), 'UNKNOWN');
});


