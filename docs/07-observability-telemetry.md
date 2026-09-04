# LAB-07 — Observability & Telemetry

> [LAB] Documento técnico e conceitual do laboratório pessoal de observabilidade distribuída aplicada a Quality Engineering. Não representa sistemas, produtos, topologias ou arquiteturas internas da TOTVS.

---

## 1. Visão Geral

O **LAB-07** implementa instrumentação mínima, determinística e útil com **OpenTelemetry** cobrindo o ciclo de vida assíncrono distribuído:

```
[API HTTP]
   │
   ▼ (http.request)
[PostgreSQL]
   │
   ├─► (db.transaction.create_instance)
   └─► (outbox.create_event)
[Outbox Publisher]
   │
   ▼ (nats.publish)
[NATS JetStream]
   │
   ▼ (nats.consume)
[Event Consumer]
   │
   ▼ (db.transaction.update_state)
[PostgreSQL Final State]
```

O objetivo primordial de Quality Engineering neste laboratório é viabilizar o diagnóstico objetivo de anomalias em fluxos distribuídos (latência, partições, duplicações, inconsistências e erros transacionais) a partir de rastreamento técnico (traces) e contadores agregados (métricas), sem acoplar a estabilidade da aplicação à disponibilidade da ferramenta de visualização.

---

## 2. Fundamentos de Telemetria: Logs vs. Metrics vs. Traces

Em arquiteturas distribuídas e assíncronas, cada pilar de telemetria responde a perguntas operacionais distintas:

| Pilar | Definição | Exemplo no LAB | Propósito em Quality Engineering |
|---|---|---|---|
| **Logs** | Registros pontuais de eventos textuais ou estruturados em um momento específico do tempo. | `[LAB EventConsumer] error processing message, not acking` | Fornece contexto forense detalhado e mensagens de erro específicas. |
| **Metrics** | Valores numéricos agregáveis medidos ao longo do tempo (contadores, medidores, histogramas). | `http_requests_total`, `outbox_publish_failures_total`, `consumer_failures_total` | Revela tendências, taxas de erro, degradação de vazão e desvios de comportamento global. |
| **Traces** | Representação causal e temporal da jornada de uma requisição através de fronteiras de rede e componentes. | `traceId` único correlacionando `http.request` até `db.transaction.update_state`. | Diagnostica quebras de fluxo assíncrono, gargalos de latência e localização exata de falhas. |

---

## 3. Semântica de Identificadores: Correlation ID vs. Trace ID vs. Span ID

A mistura de identificadores com finalidades distintas é um modo de falha frequente em sistemas de mensageria. O laboratório isola estritamente três conceitos:

```
┌────────────────────────────────────────────────────────────────────────┐
│ correlationId (Negócio): "corr-biz-order-8812"                         │
│ - Fornecido pelo cliente ou gerado na borda (string/UUID)              │
│ - Rastreia a intenção transacional de ponta a ponta                    │
└────────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌────────────────────────────────────────────────────────────────────────┐
│ traceId (Técnico W3C): "38e84021666e5a6d94183195e0c56a25" (32 hex)    │
│ - Identificador global da cadeia de execução técnica                   │
│ - Compartilhado por todos os spans do fluxo distribuído                │
└────────────────────────────────────────────────────────────────────────┘
       │
       ├─► spanId: "4063ec54682e71cb" (http.request)
       ├─► spanId: "dedd0954eb285faa" (db.transaction.create_instance)
       ├─► spanId: "b8ec831a3c7e16df" (outbox.create_event)
       ├─► spanId: "0d135913b60ccf0e" (nats.publish)
       ├─► spanId: "542a17ba99e454af" (nats.consume)
       └─► spanId: "a6fe17ba99e454af" (db.transaction.update_state)
```

1. **`correlationId`**: Identificador de negócio (auditável e rastreável pelo usuário final e logs).
2. **`traceId`**: Identificador técnico distribuído W3C de 32 dígitos hexadecimais (comum a toda a árvore causal).
3. **`spanId`**: Identificador da operação atômica de 16 dígitos hexadecimais (distinto e único para cada componente).

---

## 4. Propagação de Contexto W3C TraceContext

Para que um trace atravesse fronteiras assíncronas (HTTP → Banco Relacional → Tabela Outbox → Broker NATS → Consumidor Worker), o contexto é propagado no padrão **W3C TraceContext (`traceparent`)**:

Formato: `version-traceId-parentSpanId-traceFlags`  
Exemplo: `00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`

### Ciclo de Propagação no Pipeline:
1. **HTTP Inbound**: A API extrai `request.headers['traceparent']` se presente, ou inicializa um novo root trace span `http.request`.
2. **PostgreSQL & Outbox**: O contexto do span ativo é passado para a transação `db.transaction.create_instance` e registrado no payload JSON do evento na tabela `outbox_events.payload.traceparent`.
3. **Outbox Publisher**: Ao ler o evento pendente, o publisher extrai `payload.traceparent`, cria o span filho `nats.publish` e atualiza o `traceparent` no payload da mensagem publicada no JetStream.
4. **Event Consumer**: O consumidor extrai o `traceparent` da mensagem NATS decodificada, vincula o span `nats.consume` como filho legítimo do publisher e aninha a transação `db.transaction.update_state`.

---

## 5. Spans e Métricas para Quality Engineering

### 5.1 Spans Instrumentados

| Span Name | Tipo | Componente | Atributos Críticos |
|---|---|---|---|
| `http.request` | `SERVER` | `apps/control-plane-mock/src/app.ts` | `http.method`, `http.route`, `http.status_code`, `correlation_id` |
| `db.transaction.create_instance` | `CLIENT` | `apps/control-plane-mock/src/postgres-store.ts` | `db.system`, `db.operation`, `idempotency_key`, `correlation_id` |
| `outbox.create_event` | `PRODUCER` | `apps/control-plane-mock/src/postgres-store.ts` | `event.type`, `event.id`, `correlation_id` |
| `nats.publish` | `PRODUCER` | `apps/control-plane-mock/src/outbox-publisher.ts` | `messaging.system`, `messaging.destination`, `event.id`, `correlation_id` |
| `nats.consume` | `CONSUMER` | `apps/control-plane-mock/src/consumer.ts` | `messaging.system`, `messaging.operation`, `event.id`, `correlation_id` |
| `db.transaction.update_state` | `CLIENT` | `apps/control-plane-mock/src/consumer.ts` | `db.system`, `db.operation`, `event.id`, `instance_id`, `operation_id` |

### 5.2 Métricas de Valor Direto para QE (Baixa Cardinalidade)

- `http_requests_total` (`counter`): Total de requisições HTTP recebidas por método, rota e status code.
- `http_errors_total` (`counter`): Total de respostas de erro (4xx/5xx) agrupadas por rota e código de erro.
- `outbox_pending_count` (`updowncounter`): Quantidade instantânea de registros pendentes na tabela Outbox.
- `outbox_publish_failures_total` (`counter`): Contagem de falhas de envio ao NATS agrupadas por razão de falha.
- `messages_processed_total` (`counter`): Total de mensagens consumidas com status `processed` vs. `already_processed`.
- `consumer_failures_total` (`counter`): Falhas de processamento ocorridas no consumer.
- `message_redeliveries_total` (`counter`): Mensagens recebidas repetidamente (duplicatas/redeliveries).
- `recovery_duration_seconds` (`histogram`): Duração observada do ciclo de recuperação pós-falha.

> [!NOTE]
> Evitou-se estritamente alta cardinalidade: identificadores individuais (`instanceId`, `operationId`, `idempotencyKey`) nunca são utilizados como labels de métricas.

---

## 6. Como Observabilidade Ajuda Quality Engineering

A observabilidade moderna altera o papel do Quality Engineer de "testador de caixa preta" para "arquiteto de diagnosticabilidade":

1. **Evidência Temporal Concreta**: Diante de uma falha em teste de integração ou resiliência, o QE não precisa inferir o ponto de ruptura: o trace aponta o span exato que retornou `ERROR` e a mensagem associada (ex: `SIMULATED_PUBLISH_FAILURE` no span `nats.publish`).
2. **Validação de Não-Regressão em Cascata**: Permite verificar que um retry cliente não gerou efeitos colaterais silenciosos em instâncias posteriores.
3. **Deduplicação Comprovável**: Traces confirmam que mensagens repetidas são interceptadas na camada do consumidor sem disparar spans indevidos de mutação no banco relacional.
4. **Isolamento de Falhas Transitórias**: Diferencia falhas de comunicação com o broker de mensageria de falhas lógicas no payload ou regras de negócio.

---

## 7. Arquitetura de Infraestrutura

O ambiente local integra:
- **PostgreSQL 17**: Persistência relacional transacional e tabela Outbox.
- **NATS JetStream 2.10**: Broker de mensagens durável.
- **Toxiproxy 2.11**: Injeção controlada de falhas de rede.
- **OpenTelemetry Collector 0.110.0**: Agente centralizador OTLP (portas 4317 gRPC e 4318 HTTP).
- **Jaeger 1.60 All-in-One**: Interface web local (porta 16686) para visualização exploratória de traces.

Subida unificada:
```bash
docker compose -f infra/docker-compose.yml up -d --wait
```

---

## 8. Limitações do Laboratório

1. **[LAB] Escopo Didático**: Não há Prometheus ou Grafana configurados; a telemetria é exportada ao OTel Collector e inspecionada deterministicamente em memória nos testes.
2. **[LAB] Amostragem 100%**: Em ambientes produtivos reais, amostragem adaptativa (probabilística ou baseada em latência/erros) é necessária para conter custos de telemetria.
3. **[LAB] Resiliência Não-Bloqueante**: A indisponibilidade do OTel Collector ou do Jaeger não invalida o comportamento funcional da aplicação nem bloqueia o pipeline de Quality Gate.
