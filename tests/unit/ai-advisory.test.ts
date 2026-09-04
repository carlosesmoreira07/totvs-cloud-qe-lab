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
import type { ImpactContext } from '../../tools/impact-context.js';

const validAdvisory: AiAdvisory = {
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

test('aceita advisory que obedece ao schema', () => {
  assert.deepEqual(parseAiAdvisory(validAdvisory), validAdvisory);
});

test('adapter OpenAI aceita saída estruturada sem chamada real', async () => {
  let sentContext = '';
  const provider = new OpenAiProvider({
    apiKey: 'fake-key-for-unit-test',
    model: 'fake-structured-model',
    responseParser: async (request) => {
      sentContext = request.input;
      assert.equal(request.store, false);
      assert.equal(request.max_output_tokens, 1_800);
      return { output_parsed: validAdvisory };
    },
  });

  const outcome = await runAdvisoryAnalysis(provider, context);
  assert.equal(outcome.status, 'AVAILABLE');
  assert.match(sentContext, /qe-advisory-v1/);
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
  assert.match(formatAdvisorySummary(outcome), /AI Advisory indisponível — Quality Gate não afetado\./);
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
