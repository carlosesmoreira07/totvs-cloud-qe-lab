# Mapa de Capabilities de Quality Engineering — LAB-12

> [LAB] Catálogo consolidado de competências de engenharia de qualidade exercitadas no laboratório fictício de Cloud Control Plane.

---

## 1. Visão Geral das Capabilities

| # | Capability | Foco Primário | Camada Técnica |
|---|---|---|---|
| 1 | **API / Contract Testing** | Especificação OpenAPI 3.1 e integridade de esquemas | Playwright + SwaggerParser |
| 2 | **Idempotency & Concurrency** | Prevenção de duplicidade em retries de provisionamento | Semântica HTTP + Store em Memória/PostgreSQL |
| 3 | **Distributed Systems** | Consistência e isolamento entre serviços e banco | Node.js + PostgreSQL + NATS JetStream |
| 4 | **Outbox / Messaging** | Publicação atômica e desacoplamento assíncrono | Transactional Outbox + NATS JetStream |
| 5 | **Resilience & Recovery** | Comportamento sob partições, quedas e atrasos | Toxiproxy + Testes de Falhas Injetadas |
| 6 | **Observability & Tracing** | Diagnóstico distribuído e rastreabilidade W3C | OpenTelemetry (6 spans) + Collector + Jaeger |
| 7 | **Synthetic Journeys** | Validação ponta a ponta do ciclo de vida e SLAs sintéticos | Playwright Test + Coletor de Latências |
| 8 | **Performance & Baselines** | Concorrência e detecção determinística de regressão | k6 + Comparador de Baseline (20% tolerância) |
| 9 | **Security Quality Pack** | Detecção preventiva de vulnerabilidades e boas práticas | TruffleHog + npm audit + Semgrep + ZAP |
| 10 | **Historical Trends** | Análise temporal determinística da qualidade | Snapshots versionados + Calculador de tendências |
| 11 | **Executive Scorecard** | Visão executiva multidimensional da saúde do produto | Builder de Scorecard + JSON, MD, HTML e PDF A4 |
| 12 | **AI-Assisted QE (Consultiva)** | Interpretação rápida de contexto sem poder de gate | OpenAI Structured Outputs + Schemas Zod (AI-01..07) |

---

## 2. Detalhamento por Capability

### 1. API / Contract Testing
- **Problema que resolve:** Quebras de contrato entre frontend/clientes e o backend de controle, respostas inconsistentes e falhas de validação de payload.
- **Controle / Evidência:** Validador OpenAPI 3.1 no build (`validate-openapi.ts`), suíte Playwright de contrato (`tests/contract/`) e asserções contra esquemas JSON.
- **Valor técnico:** Detecta quebras antes da integração e mantém a documentação de contrato alinhada ao código do mock.
- **Valor de negócio:** Ajuda a reduzir retrabalho de desenvolvimento por divergência de contrato e mitiga falhas por payloads malformados.

### 2. Idempotency & Concurrency
- **Problema que resolve:** Criação acidental de recursos duplicados quando requisições idênticas sofrem retry por instabilidade de rede ou concorrência.
- **Controle / Evidência:** Suíte de concorrência e idempotência (`tests/api/idempotency.spec.ts`), teste de corridas de requisições simultâneas e chave `Idempotency-Key`.
- **Valor técnico:** Valida cardinalidade 1:1 entre chave e recurso e asserção determinística de conflito para payloads divergentes.
- **Valor de negócio:** Reduz o risco de cobranças indevidas e provisionamentos duplicados de infraestrutura sob retries.

### 3. Distributed Systems
- **Problema que resolve:** Perda de estado, divergência entre dados relacionais e eventos distribuídos, e estados fantasmas (*ghost writes*).
- **Controle / Evidência:** Suíte de integração (`tests/integration/outbox-nats.spec.ts`) validando transações atômicas no PostgreSQL e persistência de eventos no stream.
- **Valor técnico:** Assegura que o estado da base relacional e a emissão de eventos evoluam de forma consistente sob falhas locais.
- **Valor de negócio:** Preserva a integridade do inventário da nuvem e evita registros órfãos que geram incidentes de suporte.

### 4. Outbox / Messaging
- **Problema que resolve:** Perda de eventos caso o message broker fique indisponível exatamente no instante do commit da requisição na API.
- **Controle / Evidência:** Padrão Transactional Outbox com worker assíncrono (`apps/control-plane-mock/src/outbox-publisher.ts`) e NATS JetStream at-least-once.
- **Valor técnico:** Desacopla a resposta imediata da API da disponibilidade externa da mensageria com garantia de entrega eventual.
- **Valor de negócio:** Continuidade da operação do cliente mesmo durante paradas parciais ou manutenção de infraestrutura de mensageria.

### 5. Resilience & Recovery
- **Problema que resolve:** Comportamento imprevisível ou travamento da plataforma quando componentes dependentes entram em partição ou timeout.
- **Controle / Evidência:** Distributed Failure & Recovery Pack com Toxiproxy (`tests/resiliency/failure-recovery.spec.ts`), injetando latência, resets de TCP e queda do broker.
- **Valor técnico:** Validação automatizada de 6 cenários de falha e recuperação com cálculo de tempo médio de recuperação (MTTR sintético).
- **Valor de negócio:** Redução do risco de indisponibilidade prolongada e proteção contra efeito dominó de falhas em cascata.

### 6. Observability & Tracing
- **Problema que resolve:** Dificuldade em diagnosticar o ponto de ruptura de falhas em fluxos assíncronos que atravessam múltiplos processos.
- **Controle / Evidência:** OpenTelemetry instrumentado em 6 spans com contexto W3C (`traceparent`), exportação OTLP para Collector/Jaeger e suíte de telemetria (`tests/observability/`).
- **Valor técnico:** Rastreabilidade fim-a-fim de cada operação e detecção determinística de spans ausentes ou com erro.
- **Valor de negócio:** Auxilia na aceleração do diagnóstico de incidentes complexos através da visibilidade clara e correlacionada do rastro da requisição.

### 7. Synthetic Journeys
- **Problema que resolve:** Testes unitários passam isoladamente, mas a experiência ponta a ponta do usuário quebra por inconsistência de ciclo de vida.
- **Controle / Evidência:** 4 jornadas completas automatizadas (`tests/journeys/synthetic-journeys.spec.ts`) gerando `evidence/journeys/` e comparando contra limites de SLA sintético.
- **Valor técnico:** Exercita o fluxo real do usuário (criação -> polling -> conclusão -> telemetria -> consistência final).
- **Valor de negócio:** Proteção contra quebra dos fluxos mais críticos de faturamento e operação do cliente.

### 8. Performance & Baselines
- **Problema que resolve:** Regressões silenciosas de latência ou perda de vazão introduzidas em novos commits sem serem percebidas até a produção.
- **Controle / Evidência:** Execuções de carga via k6 (`performance/runner.ts`) com comparador determinístico de baseline (`baseline-comparator.ts`) e limiar de 20%.
- **Valor técnico:** Detecção de regressão em p50, p95 e p99 com histórico comparativo versionado.
- **Valor de negócio:** Manutenção de tempos de resposta rápidos e estabilidade de custos de servidores sob picos de uso.

### 9. Security Quality Pack
- **Problema que resolve:** Vazamento acidental de segredos no código, vulnerabilidades conhecidas em dependências, falhas de SAST e brechas em headers/HTTP.
- **Controle / Evidência:** Quatro scanners determinísticos (TruffleHog, npm audit, Semgrep, OWASP ZAP Baseline) + 7 controles Playwright de segurança da API (`tests/security/`).
- **Valor técnico:** Formato normalizado comum em `evidence/security/findings.json` e Security Status determinístico `GREEN` / `YELLOW` / `RED`.
- **Valor de negócio:** Redução de riscos de vazamento de dados, conformidade regulatória contínua e mitigação de vulnerabilidades antes do deploy.

### 10. Historical Trends
- **Problema que resolve:** Confundir uma flutuação pontual entre duas execuções com uma tendência real de degradação ou melhoria.
- **Controle / Evidência:** Snapshots versionados em `evidence/history/snapshots/`, consolidador `history.json` e separação conceitual estrita: `comparisonStatus` vs. `historicalTrend` ($\ge 3$ checkpoints).
- **Valor técnico:** Cálculo matemático e determinístico de evolução temporal em 9 dimensões de qualidade com sparklines integrados.
- **Valor de negócio:** Decisões estratégicas baseadas em fatos históricos e identificação precoce de desgaste na qualidade do software.

### 11. Executive Scorecard
- **Problema que resolve:** Executivos e líderes de engenharia recebem relatórios técnicos densos e não conseguem entender rapidamente a saúde do release.
- **Controle / Evidência:** Gerador de scorecard executivo (`tools/scorecard/`) consolidando dimensões em JSON, Markdown, HTML A4 landscape e PDF executivo de 2 páginas.
- **Valor técnico:** Tradução automática de dezenas de evidências técnicas em status objetivos (`GREEN`, `YELLOW`, `RED`) e ações recomendadas.
- **Valor de negócio:** Alinhamento claro entre engenharia e negócios, facilitando reuniões de Go/No-Go e governança de releases.

### 12. AI-Assisted QE (Consultiva)
- **Problema que resolve:** Sobrecarga cognitiva de engenheiros na leitura de longos diffs de código, logs de telemetria, traces complexos e histórico.
- **Controle / Evidência:** Módulos AI-01 a AI-07 com Structured Outputs Zod, pré-correlação determinística e autoridade de release 100% humana (`Risco -> Controle -> Evidência -> Decisão`).
- **Valor técnico:** Explicações imediatas em linguagem natural com classificação rígida `[OBSERVED]`, `[INFERRED]` e `[GAP]`, sem alucinações e com fallback seguro.
- **Valor de negócio:** Aceleração do ciclo de code review e investigação de qualidade sem transferir poder de decisão a modelos probabilísticos.
