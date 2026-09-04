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
- [LAB] **AI-01:** QE Intelligence Layer consultiva com provider OpenAI substituível, saída estruturada e fallback não bloqueante.

[LAB] LAB-06 e posteriores — resiliência distribuída avançada, segurança, performance, evidências executivas e descoberta de onboarding — permanecem fora desta entrega.

## Estrutura

```text
apps/control-plane-mock/       mock local, persistência PostgreSQL, Outbox Publisher e Consumer
docs/                          charter, mapa público, hipóteses, riscos, Outbox/NATS e IA assistiva
infra/                         docker-compose e scripts SQL para PostgreSQL e NATS JetStream
specs/openapi/                 contrato versionado do laboratório
tests/api/                     controles comportamentais Playwright (HTTP)
tests/contract/                validação OpenAPI e schemas de resposta
tests/integration/             controles de integração para Transactional Outbox e NATS JetStream
tools/                         validação e contexto consultivo de impacto
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

## Execução mínima

[LAB] Pré-requisitos: Node.js 22 ou superior, npm e Docker com Docker Compose.

```bash
npm ci
docker compose -f infra/docker-compose.yml up -d --wait
npm run verify
```

### Comandos de infraestrutura

```bash
# Iniciar PostgreSQL e NATS JetStream
docker compose -f infra/docker-compose.yml up -d --wait

# Verificar status dos containers
docker compose -f infra/docker-compose.yml ps

# Parar e remover volumes da infraestrutura
docker compose -f infra/docker-compose.yml down -v
```

### Execução de testes

```bash
# Executar todos os testes (unitários, api, contrato e integração)
npm test

# Executar somente os novos controles de integração Outbox/NATS (LAB-05)
npm run test:integration

# Executar suíte de contrato e API
npm run test:api
npm run test:contract
```

### Como verificar Outbox e NATS

```bash
# Consultar eventos na tabela outbox_events
docker exec -it qe-lab-postgres psql -U postgres -d control_plane -c "SELECT id, event_type, status, retry_count, published_at FROM outbox_events;"

# Consultar eventos idempotentemente processados pelo Consumer
docker exec -it qe-lab-postgres psql -U postgres -d control_plane -c "SELECT * FROM processed_events;"

# Verificar saúde e monitoramento do NATS JetStream
curl http://127.0.0.1:8222/healthz
curl http://127.0.0.1:8222/jsz
```

### Como simular falhas no laboratório

- **Falha de envio ao NATS:** no worker `OutboxPublisher`, o parâmetro `{ simulatePublishFailure: true }` simula indisponibilidade de rede/broker. O evento permanece com status `PENDING`, recebe incremento em `retry_count` e registra `last_error = 'SIMULATED_PUBLISH_FAILURE'`. No próximo ciclo com o simulador desativado, o evento é republicado com sucesso.
- **Consumer duplicado / Replay de evento:** o método `consumer.processPayload(payload)` pode ser executado múltiplas vezes com o mesmo payload. A verificação atômica em `processed_events` identifica a chave duplicada e ignora mutações subsequentes, preservando monotonicidade de estado e timestamps originais.

### Contexto de impacto e IA assistiva

```bash
# Gerar contexto determinístico de impacto
npm run impact:context

# Executar AI advisory consultivo (usa OPENAI_API_KEY se disponível)
npm run ai:advisory
```

## Comece por aqui

- [Wiki do projeto](https://github.com/carlosesmoreira07/totvs-cloud-qe-lab/wiki)
- [Charter](docs/00-charter.md)
- [Mapa público do produto](docs/01-public-product-map.md)
- [Assumption Register](docs/02-assumptions.md)
- [Mapa de riscos exercitados](docs/04-quality-risk-map.md)
- [Guia LAB-05: Outbox e NATS](docs/05-outbox-nats.md)
- [Arquitetura de IA assistiva](docs/ai-assisted-impact-analysis.md)
- [OpenAPI](specs/openapi/cloud-control-plane.yaml)
