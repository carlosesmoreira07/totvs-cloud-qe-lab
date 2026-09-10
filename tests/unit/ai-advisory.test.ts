import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AI_ADVISORY_UNAVAILABLE,
  buildAdvisoryContext,
  formatAdvisorySummary,
  runAdvisoryAnalysis,
  selectTokenBudget,
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
  confidence: 'HIGH',
  attention: ['RISK-API-005: O fluxo de retry foi alterado em apps/control-plane-mock/src/store.ts'],
  actions: ['npm run test:api'],
  humanQuestion: 'Revisar conflito: Confirmar a semântica para payload divergente',
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
  assert.match(formatted, /\*\*Impacto:\*\* MEDIUM · Confiança: HIGH/);
  assert.match(formatted, /AI advisory · decisão humana/);
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
    attention: [],
    actions: [],
    humanQuestion: null,
  };
  const outcome = {
    status: 'AVAILABLE' as const,
    provider: 'openai',
    model: 'gpt-4o',
    advisory: advisoryAllEmpty,
  };
  const formatted = formatAdvisorySummary(outcome);
  assert.doesNotMatch(formatted, /\*\*Risco:\*\*/);
  assert.doesNotMatch(formatted, /\*\*Ação:\*\*/);
  assert.doesNotMatch(formatted, /\*\*Pergunta:\*\*/);
  assert.doesNotMatch(formatted, /Nenhum item/i);
  assert.doesNotMatch(formatted, /Nenhum apontamento/i);
  assert.doesNotMatch(formatted, /### /); // sem headers H3
});

test('formatAdvisorySummary: pergunta é exibida quando preenchida e omitida quando nula', () => {
  const withQuestion: AiAdvisory = {
    ...validAdvisory,
    humanQuestion: 'Confirmar a semântica para payload divergente',
  };
  const formattedWith = formatAdvisorySummary({
    status: 'AVAILABLE' as const,
    provider: 'openai',
    model: 'gpt-4o',
    advisory: withQuestion,
  });
  assert.match(formattedWith, /\*\*Pergunta:\*\* Confirmar a semântica para payload divergente/);

  const withoutQuestion: AiAdvisory = {
    ...validAdvisory,
    humanQuestion: null,
  };
  const formattedWithout = formatAdvisorySummary({
    status: 'AVAILABLE' as const,
    provider: 'openai',
    model: 'gpt-4o',
    advisory: withoutQuestion,
  });
  assert.doesNotMatch(formattedWithout, /\*\*Pergunta:\*\*/);
});

test('formatAdvisorySummary: mudança DOCUMENTATION exibe Ação e omite Risco', () => {
  const docAdvisory: AiAdvisory = {
    changeSummary: '`GET /health` teve apenas o texto de `summary` alterado.',
    changeNature: 'DOCUMENTATION',
    impact: 'LOW',
    confidence: 'HIGH',
    attention: ['mudança documental; nenhuma alteração funcional identificada.'],
    actions: ['npm run validate:openapi'],
    humanQuestion: null,
  };
  const formatted = formatAdvisorySummary({
    status: 'AVAILABLE' as const,
    provider: 'openai',
    model: 'gpt-4o',
    advisory: docAdvisory,
  });
  assert.match(formatted, /\*\*Resumo:\*\* `GET \/health` teve apenas o texto de `summary` alterado\./);
  assert.match(formatted, /\*\*Impacto:\*\* LOW · Confiança: HIGH/);
  assert.match(formatted, /\*\*Ação:\*\* npm run validate:openapi/);
  assert.doesNotMatch(formatted, /\*\*Risco:\*\*/);
  assert.doesNotMatch(formatted, /\*\*Pergunta:\*\*/);
  assert.match(formatted, /AI advisory · decisão humana/);
});

test('formatAdvisorySummary: mudança com risco exibe Risco e Ação', () => {
  const formatted = formatAdvisorySummary({
    status: 'AVAILABLE' as const,
    provider: 'openai',
    model: 'gpt-4o',
    advisory: validAdvisory,
  });
  assert.match(formatted, /\*\*Risco:\*\* RISK-API-005/);
  assert.match(formatted, /\*\*Ação:\*\* npm run test:api/);
  assert.match(formatted, /AI advisory · decisão humana/);
});

test('regressão: resposta DOCUMENTATION cabe no budget de tokens e passa pelo schema', () => {
  const docAdvisory: AiAdvisory = {
    changeSummary: '`GET /health` teve apenas o texto de `summary` alterado.',
    changeNature: 'DOCUMENTATION',
    impact: 'LOW',
    confidence: 'HIGH',
    attention: ['mudança documental; nenhuma alteração funcional identificada.'],
    actions: ['npm run validate:openapi'],
    humanQuestion: null,
  };

  // 1. Passa com sucesso no parse do schema Zod
  const parsed = parseAiAdvisory(docAdvisory);
  assert.deepEqual(parsed, docAdvisory);

  // 2. Budget mínimo seguro para DOCUMENTATION é de 800 tokens (evita truncamento na LLM)
  const docContext: typeof context = {
    ...context,
    changes: {
      ...changes,
      openApiChanged: true,
      openApiChangeNature: 'DOCUMENTATION',
    },
  };
  const budget = selectTokenBudget(docContext);
  assert.equal(budget >= 700 && budget <= 900, true, `budget esperado entre 700-900, obteve ${budget}`);

  // 3. Tamanho do JSON serializado é compacto (< 400 caracteres / ~100 tokens), deixando ampla margem de segurança no budget de 800
  const jsonString = JSON.stringify(docAdvisory);
  assert.equal(jsonString.length < 400, true, `JSON muito extenso: ${jsonString.length} chars`);
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

test('detectOpenApiChangeNature: DOCUMENTATION para diff cosmético de aspas', () => {
  const quoteDiff = `--- a/specs/openapi/cloud-control-plane.yaml
+++ b/specs/openapi/cloud-control-plane.yaml
@@ -10,2 +10,2 @@
-  '200':
+  "200":
-    $ref: '#/components/parameters/CorrelationId'
+    $ref: "#/components/parameters/CorrelationId"`;

  assert.equal(detectOpenApiChangeNature(quoteDiff), 'DOCUMENTATION');
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


