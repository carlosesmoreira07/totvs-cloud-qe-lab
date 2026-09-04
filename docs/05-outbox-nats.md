# [LAB] LAB-05 — PostgreSQL, Transactional Outbox e NATS JetStream

> [LAB] Laboratório pessoal, público e **não oficial**. Não representa a arquitetura, processos, controles, infraestrutura ou decisões da TOTVS.

---

## 1. Por que usar Transactional Outbox?

[LAB] Em sistemas distribuídos que expõem APIs síncronas e delegam ações a mensageria assíncrona, a publicação direta de uma mensagem durante a requisição HTTP introduz o problema da **escrita dupla** (*dual-write*):

```text
       ┌─── Salva no Banco de Dados? (Sucesso)
API ───┤
       └─── Publica no Broker de Mensagens? (Falha de rede ou indisponibilidade)
```

[LAB] Se o banco commitar mas a publicação no broker falhar, o estado fica persistido sem que os consumidores fiquem sabendo. Inversamente, se a mensagem for publicada primeiro e o commit do banco falhar, consumidores processarão eventos de um recurso que sequer existe.

[LAB] O padrão **Transactional Outbox** elimina essa inconsistência gravando a intenção do evento (`outbox_events`) **na mesma transação ACID** em que as entidades de domínio (`instances` e `operations`) são salvas no PostgreSQL.

---

## 2. Onde está a fronteira transacional?

[LAB] A fronteira atômica reside na transação SQL gerenciada pelo PostgreSQL:

```text
BEGIN;
  SELECT fingerprint, operation_id FROM idempotency_records WHERE idempotency_key = $1 FOR UPDATE;
  INSERT INTO instances (id, name, region, image, flavor, status, created_at, updated_at) ...;
  INSERT INTO operations (id, type, status, resource_id, correlation_id, submitted_at, updated_at) ...;
  INSERT INTO idempotency_records (idempotency_key, fingerprint, operation_id, created_at) ...;
  INSERT INTO outbox_events (id, event_type, aggregate_type, aggregate_id, correlation_id, payload, status, created_at) ...;
COMMIT;
```

- **Tudo ou nada**: se qualquer comando falhar, o PostgreSQL realiza `ROLLBACK`. Nenhuma entidade de domínio e nenhum evento Outbox são persistidos.
- **Isolamento HTTP**: o endpoint `POST /v1/instances` retorna `202 Accepted` imediatamente após o commit local, **sem publicar diretamente no NATS JetStream**.

---

## 3. Semântica "at-least-once" e o papel do Outbox Publisher

[LAB] O **Outbox Publisher** é um worker simples que busca registros pendentes no banco e os entrega ao NATS JetStream:

1. Executa `SELECT ... FROM outbox_events WHERE status = 'PENDING' FOR UPDATE SKIP LOCKED`.
2. Publica no NATS JetStream sob o subject `instance.provisioning.requested`, associando o ID do evento ao cabeçalho `Nats-Msg-Id` (`msgID`) para deduplicação no broker.
3. Aguarda o `PubAck` do JetStream.
4. Somente após confirmação explícita (`ack`), atualiza o registro para `status = 'PUBLISHED'`, gravando `published_at = NOW()`.
5. Em caso de falha de rede ou indisponibilidade, o registro permanece como `PENDING`, recebe incremento em `retry_count` e registra o erro em `last_error`. O próximo ciclo do worker tentará republicá-lo.

[LAB] Essa garantia assegura entrega **at-least-once** (pelo menos uma vez): nenhum evento confirmado na transação do banco é perdido, mas falhas de rede durante o ACK podem causar reenvios.

---

## 4. Por que o Consumer deve ser idempotente?

[LAB] Como a entrega é *at-least-once*, o consumidor pode receber a mesma mensagem mais de uma vez devido a:
- Reenvio do publisher após timeout de ACK;
- Reentrega do JetStream por expiração do ack wait;
- Replay operacional manual de eventos.

[LAB] Para garantir consistência sem efeitos colaterais redundantes, o **EventConsumer** adota uma tabela de controle idempotente (`processed_events`):

```text
Mensagem recebida: { eventId, instanceId, operationId, correlationId }
  │
  ▼
BEGIN;
  SELECT event_id FROM processed_events WHERE event_id = $1 FOR UPDATE;
  ┌─────────────────────────┴─────────────────────────┐
  │ Existe                                            │ Não existe
  ▼                                                   ▼
COMMIT;                                             UPDATE operations SET status = 'SUCCEEDED' ...;
Acknowledge mensagem (msg.ack());                    UPDATE instances SET status = 'RUNNING' ...;
Retorna: already_processed (sem efeito)             INSERT INTO processed_events (event_id, ...);
                                                    COMMIT;
                                                    Acknowledge mensagem (msg.ack());
```

- Tentativas repetidas não alteram timestamps nem o estado do recurso.
- O correlationId original é preservado em todas as etapas de ponta a ponta.

---

## 5. Limitações conscientes do LAB

[LAB] Este laboratório foi desenhado para estudo e diagnóstico controlado de qualidade:

1. **Topologia única**: PostgreSQL e NATS rodam localmente via Docker Compose em container único (não clusterizados).
2. **Sem Dead Letter Queue (DLQ) avançada**: eventos com falhas sucessivas permanecem com `retry_count` incrementado no banco para auditoria, sem redirecionamento para fila morta automática.
3. **Sem Change Data Capture (CDC)**: o polling na tabela `outbox_events` utiliza `FOR UPDATE SKIP LOCKED`. Ferramentas como Debezium / logical decoding não foram introduzidas para manter a simplicidade do laboratório.
4. **Sem observabilidade distribuída**: métricas OpenTelemetry, traces distribuídos e dashboards permanecem fora do escopo (débitos para fases futuras).
