# TOTVS Cloud QE Lab

> [LAB] Laboratório pessoal, público e **não oficial**. Não representa a arquitetura, os processos, os controles, os dados ou as decisões da TOTVS.

[LAB] Este repositório exercita Quality Engineering aplicado a um control plane de nuvem fictício e pequeno. O fio condutor é:

```text
Risco -> Controle -> Evidência -> Decisão
```

[LAB] A maturidade de referência vem dos princípios do repositório público [`quality-engineering-lab`](https://github.com/carlosesmoreira07/quality-engineering-lab), adaptados a este domínio sem copiar sua solução ou presumir conhecimento interno.

## Classificação obrigatória

| Marcador | Uso |
|---|---|
| `[PUB]` | Informação pública confirmada em fonte citada |
| `[VAGA]` | Informação explicitamente publicada no escopo da vaga |
| `[LAB]` | Decisão criada exclusivamente para este laboratório |
| `[VALIDAR]` | Hipótese que só poderá ser confirmada após o onboarding |

## Entrega atual

- [LAB] **LAB-01:** charter, mapa público do produto e registro de hipóteses.
- [LAB] **LAB-02:** OpenAPI 3.1 e mock executável de um Cloud Control Plane fictício.
- [LAB] **LAB-03:** controles Playwright de API e contrato focados nos riscos do MVP.
- [LAB] **LAB-04:** semântica explícita e controles de idempotência, retry e concorrência no provisionamento assíncrono.
- [LAB] **LAB-05:** PostgreSQL + Transactional Outbox + NATS JetStream com garantias at-least-once, consumer idempotente e controles de falhas simuladas.
- [LAB] **LAB-06:** Distributed Failure & Recovery Pack com Toxiproxy, controles de degradação e recuperação, consistência final e evidências diagnósticas em JSON.
- [LAB] **LAB-07:** Observability & Telemetry distribuída mínima com OpenTelemetry (spans nas 6 etapas do ciclo assíncrono, métricas QE de baixa cardinalidade, OpenTelemetry Collector e Jaeger local).
- [LAB] **LAB-08:** Synthetic & End-to-End Control Plane Journeys validando o fluxo ponta a ponta do usuário, idempotência em voo, tolerância a falhas transitórias e SLAs sintéticos com evidências em JSON.
- [LAB] **LAB-09:** Performance & Baseline Quality Pack com k6, cenários de concorrência e idempotência paralela, detecção determinística de regressão contra baseline versionado e evidências em JSON.
- [LAB] **LAB-10:** Security Quality Pack com TruffleHog, `npm audit`, Semgrep, OWASP ZAP Baseline local, controles Playwright de API e evidências normalizadas.
- [LAB] **AI-01:** QE Intelligence Layer consultiva com provider OpenAI substituível, saída estruturada e fallback não bloqueante.
- [LAB] **AI-02:** Failure Intelligence consultivo correlacionando métricas determinísticas e evidências de resiliência distribuída do LAB-06.
- [LAB] **AI-03:** Telemetry & Trace Intelligence correlacionando traces OpenTelemetry (LAB-07), métricas agregadas e falhas distribuídas com classificações estritas `[OBSERVED]`, `[INFERRED]` e `[GAP]`.
- [LAB] **AI-04:** Journey Intelligence consultivo correlacionando jornadas sintéticas completas (LAB-08), SLAs sintéticos e evidências distribuídas.
- [LAB] **AI-05:** Executive Quality Scorecard determinístico em JSON/Markdown/HTML/PDF, com interpretação LLM opcional, estruturada e não bloqueante.

[LAB] LAB-11 e posteriores — IAM, DAST ativo, pentest, stress testing destrutivo em escala, soak testing de longa duração, observabilidade corporativa e descoberta de onboarding — permanecem fora desta entrega.

## Estrutura

```text
apps/control-plane-mock/       mock local, persistência PostgreSQL, Outbox Publisher, Consumer e Telemetria
docs/                          charter, mapa público, hipóteses, riscos, Outbox/NATS, resiliência, observabilidade e IA assistiva
evidence/journeys/             evidências estruturadas em JSON das jornadas sintéticas E2E (LAB-08)
evidence/observability/        evidências estruturadas em JSON dos cenários de telemetria e tracing (LAB-07)
evidence/performance/          evidências estruturadas em JSON de baselines e comparações de performance (LAB-09)
evidence/resiliency/           evidências estruturadas em JSON dos cenários de falha e recuperação (LAB-06)
evidence/scorecard/            scorecard atual em JSON, Markdown, HTML e PDF (AI-05)
evidence/security/             findings normalizados e resumo determinístico de segurança (LAB-10)
infra/                         docker-compose (PostgreSQL, NATS JetStream, Toxiproxy, OTel Collector, Jaeger) e configs
performance/                   scripts k6, limiares, orquestrador e comparador de baseline (LAB-09)
specs/openapi/                 contrato versionado do laboratório
tests/api/                     controles comportamentais Playwright (HTTP)
tests/contract/                validação OpenAPI e schemas de resposta
tests/integration/             controles de integração para Transactional Outbox e NATS JetStream
tests/journeys/                controles de jornadas sintéticas ponta a ponta e SLAs (LAB-08)
tests/performance/             controles de baseline de performance e capacidade (LAB-09)
tests/resiliency/              controles de degradação e recuperação distribuída (LAB-06)
tests/observability/           controles de tracing distribuído e métricas QE (LAB-07)
tests/security/                controles de segurança comportamental da API local (LAB-10)
tools/                         validação e contexto consultivo de impacto
tools/scorecard/               normalização, regras determinísticas e renderização do scorecard
tools/security/                adapters, schemas e regras determinísticas do Security Quality Pack
.github/workflows/             gate mínimo, objetivo e determinístico
```

## Arquitetura LAB-05: Transactional Outbox + NATS JetStream

[LAB] O laboratório evoluiu de um processo puramente em memória para uma arquitetura distribuída e transacional para estudar consistência eventual, entrega assíncrona, retries e idempotência:

```text
API (POST /v1/instances)
  │ (mesma transação ACID PostgreSQL)
  ├──> instances (PROVISIONING)
  ├──> operations (PENDING)
  └──> outbox_events (status: PENDING)
         │
         ▼ (Worker OutboxPublisher com lock SKIP LOCKED)
NATS JetStream (stream: EVENTS, subject: instance.provisioning.requested, msgID)
         │
         ▼ (Inscrição durável - EventConsumer)
PostgreSQL (Transação idempotente)
  ├──> Consulta processed_events (deduplicação)
  ├──> operations (transição para SUCCEEDED)
  ├──> instances (transição para RUNNING)
  └──> processed_events (gravação do eventId processado)
```

## Arquitetura LAB-06: Distributed Failure & Recovery Pack

[LAB] O laboratório estende o pipeline assíncrono com validação determinística de resiliência sob falhas distribuídas reais e controladas (via **Toxiproxy** e falhas programáticas de worker):

```text
Cenário 1: NATS fora do ar durante publish   ──> API responde 202; Outbox PENDING; Publisher reintenta após recovery.
Cenário 2: Consumer fora do ar               ──> Mensagem retida durável no JetStream; processada uma vez ao voltar.
Cenário 3: Redelivery da mesma mensagem       ──> processed_events impede mutação duplicada (idempotência atômica).
Cenário 4: Crash do Publisher em processamento──> Evento reprocessado com segurança; JetStream deduplica msgID.
Cenário 5: Timeout/retry da API               ──> Persistência ACID garante idempotência do LAB-04 com outbox.
Cenário 6: Falha no Consumer antes do ACK     ──> Transação sofre rollback, sem ACK prematuro; reentrega converge.
```

[LAB] **Toxiproxy** roda via Docker Compose na porta `8474` (API HTTP) e expõe a porta `4223` com proxy para `nats:4222`, permitindo injetar partições de rede com zero bibliotecas pesadas de chaos engineering.

## Execução mínima

[LAB] Pré-requisitos: Node.js 22 ou superior, npm e Docker com Docker Compose.

```bash
npm ci
docker compose -f infra/docker-compose.yml up -d --wait
npm run verify
```

### Comandos de infraestrutura

```bash
# Iniciar PostgreSQL, NATS JetStream e Toxiproxy
docker compose -f infra/docker-compose.yml up -d --wait

# Verificar status dos containers
docker compose -f infra/docker-compose.yml ps

# Parar e remover volumes da infraestrutura
docker compose -f infra/docker-compose.yml down -v
```

### Execução de testes

```bash
# Executar todos os testes (unitários, api, contrato, integração, resiliência, observabilidade, jornadas e performance)
npm test

# Executar testes de performance com k6 e comparador de baseline (LAB-09)
npm run test:performance

# Executar testes de performance em modo smoke rápido (LAB-09)
npm run test:performance:smoke

# Executar somente as jornadas sintéticas ponta a ponta (LAB-08)
npm run test:journeys

# Executar somente os controles de observabilidade e telemetria (LAB-07)
npm run test:observability

# Executar somente os controles de resiliência distribuída (LAB-06)
npm run test:resiliency

# Executar somente os controles de integração Outbox/NATS (LAB-05)
npm run test:integration

# Executar suíte de contrato e API
npm run test:api
npm run test:contract

# Executar controles de segurança da API e os quatro scanners locais
npm run test:security
npm run security:scan
```

### Evidências diagnósticas em JSON (LAB-06, LAB-07 e LAB-08)

[LAB] As suítes produzem artefatos JSON determinísticos para consumo futuro pela QE Intelligence Layer:

- `evidence/journeys/*.json`: jornadas sintéticas ponta a ponta, latência de aceitação, duração E2E, tempo de recuperação e conformidade com SLA;
- `evidence/performance/*.json`: linha de base de performance, métricas p50/p95/p99, vazão, integridade concorrente e status de regressão;
- `evidence/resiliency/*.json`: cenários de degradação, recuperação e consistência distribuída;
- `evidence/observability/*.json`: árvore de 6 spans, propagação de traceId, separação de IDs, visibilidade de erros e exatidão de métricas.
- `evidence/security/*.json`: resultados normalizados de secrets, dependências, SAST, DAST e Security Status determinístico.

### Como verificar Telemetria e Jaeger (LAB-07)

```bash
# Interface Web do Jaeger (visualização local de traces)
http://localhost:16686

# OpenTelemetry Collector (recepção OTLP)
gRPC: http://localhost:4317
HTTP: http://localhost:4318
```

### Como verificar Outbox, NATS e Toxiproxy

```bash
# Consultar eventos na tabela outbox_events
docker exec -it qe-lab-postgres psql -U postgres -d control_plane -c "SELECT id, event_type, status, retry_count, published_at FROM outbox_events;"

# Consultar eventos idempotentemente processados pelo Consumer
docker exec -it qe-lab-postgres psql -U postgres -d control_plane -c "SELECT * FROM processed_events;"

# Verificar saúde e monitoramento do NATS JetStream
curl http://127.0.0.1:8222/healthz
curl http://127.0.0.1:8222/jsz

# Inspecionar proxies configurados no Toxiproxy
curl http://127.0.0.1:8474/proxies
```

### Contexto de impacto e IA assistiva

```bash
# Gerar contexto determinístico de impacto
npm run impact:context

# Executar AI advisory consultivo (análise de impacto de PR)
npm run ai:advisory

# Executar AI failure advisory consultivo (Failure Intelligence LAB-06)
npm run ai:failure-advisory

# Executar AI telemetry advisory consultivo (Telemetry & Trace Intelligence AI-03)
npm run ai:telemetry-advisory

# Executar AI journey advisory consultivo (Journey Intelligence AI-04)
npm run ai:journey-advisory

# Gerar JSON, Markdown, HTML e PDF do scorecard determinístico (AI-05)
npm run scorecard

# Executar interpretação consultiva do scorecard; sem chave retorna fallback seguro
npm run ai:scorecard
```

## Comece por aqui

- [Wiki do projeto](https://github.com/carlosesmoreira07/totvs-cloud-qe-lab/wiki)
- [Charter](docs/00-charter.md)
- [Mapa público do produto](docs/01-public-product-map.md)
- [Assumption Register](docs/02-assumptions.md)
- [Mapa de riscos exercitados](docs/04-quality-risk-map.md)
- [Guia LAB-05: Outbox e NATS](docs/05-outbox-nats.md)
- [Modelo de Falhas Distribuídas LAB-06](docs/06-distributed-failure-model.md)
- [Guia LAB-07: Observabilidade e Telemetria](docs/07-observability-telemetry.md)
- [Guia LAB-08: Jornadas Sintéticas E2E](docs/08-synthetic-journeys.md)
- [Guia LAB-09: Performance e Baseline](docs/09-performance-baseline.md)
- [Guia AI-05: Executive Quality Scorecard](docs/10-executive-quality-scorecard.md)
- [Guia LAB-10: Security Quality Pack](docs/11-security-quality-pack.md)
- [Arquitetura de IA assistiva](docs/ai-assisted-impact-analysis.md)
- [OpenAPI](specs/openapi/cloud-control-plane.yaml)
