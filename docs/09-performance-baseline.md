# [LAB] Performance & Baseline Quality Pack (LAB-09)

## 1. Contexto e Objetivos

No contexto de Quality Engineering aplicado a um Cloud Control Plane `[LAB]`, a validação funcional e de resiliência distribuída (LAB-01 a LAB-08) é complementada pela avaliação de capacidade e comportamento temporal sob concorrência.

Este pacote estabelece uma camada didática, determinística e reproduzível de **Performance Testing e Baseline Quality** para o fluxo:

$$\text{Client / k6} \longrightarrow \text{API Fastify} \longrightarrow \text{PostgreSQL (Outbox)} \longrightarrow \text{NATS JetStream} \longrightarrow \text{Async Worker}$$

### 1.1 Objetivos de QE

1. **Mensurar Latência e Throughput:** Avaliar métricas temporais p50, p95 e p99 da API sob concorrência moderada.
2. **Garantir Confiabilidade Idempotente sob Concorrência:** Comprovar que requisições paralelas com a mesma chave de idempotência nunca geram recursos ou operações duplicadas no banco relacional.
3. **Avaliar Degradação de Jornada E2E:** Medir a duração ponta a ponta (`e2e_duration`) de provisionamento assíncrono completo durante concorrência.
4. **Detecção Determinística de Regressão:** Comparar execuções atuais contra uma linha de base versionada (`evidence/performance/baseline.json`), classificando a saúde em `IMPROVED`, `STABLE` ou `REGRESSED` com tolerância de 20%.

> [!IMPORTANT]
> **Isenção de Escopo `[LAB]`:** Todos os dados, SLAs, volumes de carga e métricas apresentados são estritamente hipotéticos e didáticos para este laboratório. Não representam topologia, capacidade, volumetria ou métricas operacionais internas da TOTVS.

---

## 2. Diferenciação Conceitual de Testes de Carga

Em Quality Engineering, é essencial categorizar com clareza o tipo de teste de carga executado para evitar falsas expectativas e sobrecarga desnecessária de infraestrutura:

| Tipo de Teste | Objetivo | Duração Típica | Escopo do LAB-09 |
| :--- | :--- | :--- | :--- |
| **Baseline / Capacidade** | Estabelecer referências nominais de latência (p50/p95/p99) e vazão sob carga esperada; detectar regressões no Quality Gate. | Curta (10s a 60s) | **Sim (Foco Principal do LAB-09)** `[LAB]` |
| **Stress Testing** | Identificar o ponto de ruptura do sistema sob carga extrema além dos limites nominais. | Moderada (minutos) | Não (reservado para exercícios específicos de caos) |
| **Soak / Endurance** | Detectar vazamentos de memória (memory leaks), exaustão de conexões de pool e degradação acumulada ao longo do tempo. | Longa (horas/dias) | Não (inadequado para loops rápidos de CI determinístico) |

O LAB-09 concentra-se estritamente em **Baseline & Capacity Testing**, permitindo execuções rápidas e determinísticas no CI/CD local e no GitHub Actions.

---

## 3. Cenários de Performance Implementados

### Cenário 1: API Baseline sob Concorrência
- **Foco:** Endpoints síncronos de consulta (`GET /health`, `GET /v1/instances`) e comandos com idempotência única (`POST /v1/instances`).
- **Concorrência:** 5 a 10 VUs (Virtual Users) em k6.
- **Métricas:** Throughput (req/s), Latência (p50, p95, p99), Taxa de Erro (HTTP 5xx).

### Cenário 2: Idempotência Concorrente (Corrida Idempotente)
- **Foco:** Múltiplas requisições paralelas (10 VUs) disparando a exata mesma requisição `POST /v1/instances` com o mesmo `Idempotency-Key` e idêntico payload.
- **Validação:** Apenas uma requisição pode receber HTTP 202 (ou 200/202 para respostas idênticas cacheadas); nenhuma resposta pode retornar 500; **zero recursos duplicados** (`duplicateResources = 0`) e **zero operações duplicadas** (`duplicateOperations = 0`) no PostgreSQL.

### Cenário 3: Jornada E2E sob Carga
- **Foco:** Jornada completa de provisionamento: `POST /v1/instances` $\rightarrow$ resposta HTTP 202 com `operation_id` $\rightarrow$ polling via `GET /v1/operations/{id}` até o estado terminal `SUCCEEDED`.
- **Métricas Customizadas:** `e2e_duration` (trend k6 medindo o ciclo de vida completo até o worker processar o evento NATS JetStream).

---

## 4. Métricas e Limiares (Thresholds) `[LAB]`

Os limiares estabelecidos em `performance/thresholds.js` definem os critérios determinísticos de aceitação para o laboratório:

```javascript
export const LAB_PERFORMANCE_THRESHOLDS = {
  api: {
    p95LatencyMs: 1500,     // Latência p95 < 1500ms
    p99LatencyMs: 3000,     // Latência p99 < 3000ms
    errorRate: 0.01,        // Erros < 1%
    minThroughputRps: 5.0,  // Throughput mínimo sustentado
  },
  idempotency: {
    maxFailures: 0,         // Zero requisições com falha interna 5xx
    maxDuplicates: 0,       // Zero registros duplicados no banco
  },
  journey: {
    p95E2eDurationMs: 15000, // Ciclo assíncrono E2E p95 < 15s
    successRate: 0.95,       // Conclusão com sucesso >= 95%
  },
  comparator: {
    regressionToleranceRatio: 0.20, // 20% de tolerância para regressão
  },
};
```

---

## 5. Comparador Determinístico de Baseline

O comparador (`performance/baseline-comparator.ts`) opera sem dependência probabilística de IA:

1. **Leitura da Linha de Base:** Carrega `evidence/performance/baseline.json`. Se o arquivo não existir, classifica a execução como `NO_BASELINE` e gera um novo artefato de referência.
2. **Comparação Métrica a Métrica:**
   - Para métricas onde **menor é melhor** (latência p50, p95, p99, taxa de erro):
     $$\text{ratio} = \frac{\text{current} - \text{baseline}}{\text{baseline}}$$
     Se $\text{ratio} > 0.20$ (+20% pior), é classificado como `REGRESSED`. Se $\text{ratio} < -0.10$ (-10% melhor), é classificado como `IMPROVED`.
   - Para métricas onde **maior é melhor** (throughput req/s):
     $$\text{ratio} = \frac{\text{baseline} - \text{current}}{\text{baseline}}$$
     Se $\text{ratio} > 0.20$, é classificado como `REGRESSED`.
3. **Decisão Global:** Se qualquer métrica crítica regredir além de 20%, o status geral é `REGRESSED`. Caso contrário, mantém-se `STABLE` ou `IMPROVED`.
4. **Persistência de Evidência:** O resultado consolidado é gravado em `evidence/performance/current.json`.

---

## 6. Cadeia Risco $\rightarrow$ Controle $\rightarrow$ Evidência $\rightarrow$ Decisão

| Risco (Risk ID) | Descrição do Risco | Controle Executável (Control ID) | Evidência Produzida | Decisão / Gate |
| :--- | :--- | :--- | :--- | :--- |
| `RISK-PERF-001` | Degradação de latência da API síncrona sob concorrência moderada. | `CTRL-PERF-001` (`k6 api-baseline.js` / runner) | `evidence/performance/current.json` (`api_baseline`) | Falha se p95 > 1500ms ou erro > 1%. |
| `RISK-PERF-002` | Falha de integridade ou duplicação sob chamadas idempotentes concorrentes. | `CTRL-PERF-002` (k6 concurrent idempotency + query SQL) | `evidence/performance/current.json` (`idempotency_concurrency`) | Bloqueante se `duplicateResources > 0` ou `duplicateOperations > 0`. |
| `RISK-PERF-003` | Degradação no tempo de ciclo de processamento da jornada assíncrona E2E. | `CTRL-PERF-003` (`k6 journey-baseline.js` custom metric `e2e_duration`) | `evidence/performance/current.json` (`journey_baseline`) | Falha se `p95E2eDurationMs > 15000ms` ou conclusão < 95%. |
| `RISK-PERF-004` | Regressão de performance não detectada em relação à linha de base histórica. | `CTRL-PERF-004` (`performance/baseline-comparator.ts`) | `evidence/performance/current.json` (`comparison`) | Falha se status for `REGRESSED` com desvios > 20%. |
| `RISK-PERF-005` | Inconsistência nos artefatos de evidência de performance para auditoria de QE. | `CTRL-PERF-005` (validação de schema e integridade JSON) | `evidence/performance/current.json` | Valida campos obrigatórios (`environment`, `metrics`, `comparison`). |

---

## 7. Como Executar

### Pré-requisitos
Infraestrutura Docker ativa:
```bash
docker compose -f infra/docker-compose.yml up -d --wait
```

### Execução dos Testes de Performance
```bash
# Execução completa de baseline (k6 + relacional + comparador)
npm run test:performance

# Execução rápida (modo smoke - 2s/cenário) para CI rápido
npm run test:performance:smoke

# Execução via Playwright Test Suite
npx playwright test tests/performance
```

---

## 8. Arquitetura de Ferramentas

```
totvs-cloud-qe-lab/
├── performance/
│   ├── thresholds.js           # Limiares e constantes k6 [LAB]
│   ├── api-baseline.js          # Script k6 para API baseline e concorrência
│   ├── journey-baseline.js      # Script k6 para jornada assíncrona E2E
│   ├── baseline-comparator.ts   # Algoritmo de detecção determinística de regressão
│   └── runner.ts                # Orquestrador local com startup efêmero e fallback
├── tests/performance/
│   └── performance.spec.ts      # Suite Playwright com annotations RISK e CTRL
├── evidence/performance/
│   ├── baseline.json            # Linha de base de referência
│   └── current.json             # Evidência gerada da última execução
└── docs/
    └── 09-performance-baseline.md # Esta especificação técnica
```
