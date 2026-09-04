# [LAB] LAB-06 — Distributed Failure & Recovery Model

> [LAB] Laboratório pessoal, público e **não oficial**. Não representa a arquitetura, processos, controles, infraestrutura ou decisões da TOTVS.

---

## 1. Visão Geral do Modelo de Falhas

[LAB] Este documento formaliza o modelo de falhas distribuídas e recuperação do laboratório para o fluxo:

```text
API (HTTP) ──> PostgreSQL (ACID) ──> Outbox Worker ──> NATS JetStream ──> Consumer (Idempotente)
```

[LAB] O objetivo de Quality Engineering neste laboratório não é apenas verificar se o sistema "volta ao ar" após uma pane, mas comprovar:
1. **Comportamento durante a degradação**: ausência de efeitos colaterais espúrios, vazamento de estado parcial ou quebra de contrato síncrono.
2. **Invariantes de consistência**: propriedades lógicas e de integridade que permanecem verdadeiras antes, durante e depois da falha.
3. **Condições determinísticas de recuperação**: capacidade de drenar eventos represados e convergir para o estado final consistente sem intervenção manual.
4. **Evidência diagnóstica estruturada**: geração de artefatos legíveis por humanos e serializáveis para a QE Intelligence Layer.

---

## 2. Catálogo dos Cenários de Falha e Recuperação

### Cenário 1: NATS indisponível durante publicação

- **Failure Mode**: queda do broker NATS, timeout de conexão ou corte de rede entre o Outbox Publisher e o broker durante a tentativa de envio.
- **Blast Radius**: isolado na camada de mensageria assíncrona; a API HTTP síncrona e a persistência de domínio não são afetadas.
- **Expected Degraded Behavior**:
  - A API HTTP continua aceitando requisições `POST /v1/instances` e retornando `202 Accepted` normalmente.
  - A instância permanece persistida com `status = 'PROVISIONING'` e a operação com `status = 'PENDING'`.
  - O evento na tabela `outbox_events` permanece com `status = 'PENDING'`, incrementa `retry_count` e registra o erro em `last_error`.
- **Recovery Condition**: restabelecimento da conectividade com o NATS. No próximo ciclo de polling do `OutboxPublisher`, o evento é publicado com confirmação de `PubAck`.
- **Consistency Invariant**: nenhum evento é descartado do banco relacional; a API não falha por indisponibilidade de mensageria assíncrona; o estado converge para `PUBLISHED` e subsequentemente para `RUNNING`/`SUCCEEDED`.
- **Controle associado**: `CTRL-RES-NATS-OUTAGE-001` (`RISK-RES-001`).

---

### Cenário 2: Consumer indisponível

- **Failure Mode**: processo do consumidor parado, em crash loop ou indisponível enquanto eventos continuam sendo publicados no NATS JetStream.
- **Blast Radius**: represamento de mensagens no stream do JetStream; latência de conclusão do provisionamento assíncrono aumenta.
- **Expected Degraded Behavior**:
  - O evento é publicado com sucesso pelo publisher e marcado como `status = 'PUBLISHED'` no banco de dados.
  - No banco, a operação permanece `PENDING` e a instância `PROVISIONING`.
  - A mensagem permanece armazenada de forma durável no Stream JetStream `EVENTS`.
- **Recovery Condition**: reinicialização do `EventConsumer` com subscrição durável.
- **Consistency Invariant**: nenhuma mensagem retida no Stream durável é perdida ou descartada; ao retornar, o consumidor drena a mensagem e realiza exatamente uma transição de estado no banco.
- **Controle associado**: `CTRL-RES-CONSUMER-OUTAGE-001` (`RISK-RES-002`).

---

### Cenário 3: Redelivery da mesma mensagem (At-Least-Once Replay)

- **Failure Mode**: reentrega repetida da mesma mensagem pelo broker (por expiração de ack wait, reenvio da rede ou replay operacional).
- **Blast Radius**: entrega redundante de mensagens na porta de entrada do consumidor.
- **Expected Degraded Behavior**:
  - O consumidor recebe múltiplas entregas com os mesmos `eventId`, `instanceId` e `operationId`.
  - A verificação relacional atômica (`INSERT INTO processed_events ... ON CONFLICT DO NOTHING`) intercepta as entregas secundárias.
  - As mensagens redundantes recebem `msg.ack()` para evitar loop infinito na fila, retornando `already_processed`.
- **Recovery Condition**: absorção imediata e transparente pelo mecanismo de idempotência.
- **Consistency Invariant**: o estado da operação permanece `SUCCEEDED` e da instância `RUNNING`; os campos `updated_at` não sofrem mutações secundárias; a tabela `processed_events` mantém cardinalidade 1 para o `eventId`.
- **Controle associado**: `CTRL-RES-REDELIVERY-001` (`RISK-RES-003`).

---

### Cenário 4: Reinício do publisher entre leitura e conclusão

- **Failure Mode**: processo do worker publisher é morto (SIGKILL / interrupção de container) após ler o evento do banco com `FOR UPDATE SKIP LOCKED`, mas antes de persistir `PUBLISHED`.
- **Blast Radius**: interrupção do ciclo corrente do worker; evento permanece em voo na memória do processo finalizado.
- **Expected Degraded Behavior**:
  - A conexão do worker morto com o PostgreSQL é encerrada pelo pool, liberando o lock e realizando rollback implícito da transação não confirmada.
  - O evento permanece intacto com `status = 'PENDING'` no banco relacional.
- **Recovery Condition**: inicialização de uma nova instância do `OutboxPublisher`, que seleciona o evento pendente e o publica no NATS JetStream informando o cabeçalho de deduplicação `msgID = event.id`.
- **Consistency Invariant**: eventos em voo não são perdidos nem corrompidos; caso o evento já tenha atingido o broker antes do crash, o JetStream deduplica pelo `msgID`; o banco é atualizado para `PUBLISHED`.
- **Controle associado**: `CTRL-RES-PUBLISHER-CRASH-001` (`RISK-RES-004`).

---

### Cenário 5: Timeout e retry da API cliente com persistência

- **Failure Mode**: cliente HTTP dispara requisição de criação, o banco PostgreSQL persiste o recurso e o evento Outbox, mas o cliente sofre timeout de rede antes de receber a resposta HTTP 202.
- **Blast Radius**: tentativa de repetição cliente gerando potenciais recursos duplicados.
- **Expected Degraded Behavior**:
  - O cliente reenvia a mesma requisição com a mesma `Idempotency-Key` e um novo `X-Correlation-Id` da tentativa.
  - O `PostgresControlPlaneStore` consulta a tabela `idempotency_records` e detecta o replay com o mesmo fingerprint.
  - Retorna `202 Accepted` com cabeçalho `Idempotency-Replayed: true` e os mesmos `operation.id` e `resourceId`.
- **Recovery Condition**: resolução síncrona na primeira retentativa cliente.
- **Consistency Invariant**: cardinalidade estritamente 1 em `instances`, `operations` e `outbox_events`; correlação da primeira tentativa é preservada; nenhuma operação ou instância fantasma é criada.
- **Controle associado**: `CTRL-RES-API-TIMEOUT-RETRY-001` (`RISK-RES-005`).

---

### Cenário 6: Falha controlada durante processamento do consumer

- **Failure Mode**: erro de execução, falha de validação ou exceção inesperada dentro da transação do consumidor antes de gravar o estado final e antes de emitir o ACK.
- **Blast Radius**: falha no processamento local de uma mensagem recebida.
- **Expected Degraded Behavior**:
  - A transação PostgreSQL do consumidor sofre `ROLLBACK` atômico completo.
  - Nenhuma alteração parcial permanece em `operations`, `instances` ou `processed_events`.
  - O consumidor NÃO chama `msg.ack()`, permitindo que o broker reentregue a mensagem no próximo ciclo.
- **Recovery Condition**: reprocessamento da mensagem sem a falha forçada, commit transacional e emissão posterior de `msg.ack()`.
- **Consistency Invariant**: ausência de estados zumbis (ex: `processed_events` gravado sem atualizar `instances`, ou vice-versa); a convergência para `SUCCEEDED`/`RUNNING` só ocorre junto ao registro de auditoria do evento.
- **Controle associado**: `CTRL-RES-CONSUMER-FAIL-BEFORE-ACK-001` (`RISK-RES-006`).

---

## 3. Deduplicação no NATS JetStream vs. Idempotência do Consumer

[LAB] Uma decisão arquitetural crítica abordada no LAB-06 diz respeito aos limites da deduplicação na camada de mensageria:

1. **Janela limitada do JetStream (`duplicate_window`)**:
   - O NATS JetStream oferece deduplicação baseada no cabeçalho `Nats-Msg-Id` (`msgID`).
   - Essa janela de deduplicação possui limite temporal configurável (default de 2 minutos). Após esse intervalo, o broker descarta o hash da mensagem de sua memória para economizar recursos.
   - Consequentemente, replays de eventos que ocorram após o encerramento da janela seriam aceitos pelo broker como mensagens novas.
2. **Idempotência Relacional Obrigatória no Consumer**:
   - Por conta dessa janela efêmera, o consumidor **nunca pode confiar exclusivamente no broker** para garantia de unicidade.
   - O laboratório adota a tabela relacional `processed_events` com chave primária em `event_id` e execução via:
     ```sql
     INSERT INTO processed_events (event_id, consumer_name, processed_at)
     VALUES ($1, 'instance-provisioning-consumer', NOW())
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id;
     ```
   - Isso garante deduplicação atômica e perpétua, mesmo se dois consumidores concorrentes receberem a mensagem no exato mesmo milissegundo ou se o replay ocorrer dias após a publicação original.

---

## 4. Evidências de Resiliência para a QE Intelligence Layer

[LAB] Cada cenário executado produz deterministicamente um artefato JSON em `evidence/resiliency/<scenario>.json`:

```json
{
  "scenario": "nats-outage-during-publish",
  "riskId": "RISK-RES-001",
  "controlId": "CTRL-RES-NATS-OUTAGE-001",
  "startedAt": "2026-09-04T05:04:50.651Z",
  "recoveredAt": "2026-09-04T05:04:50.757Z",
  "durationMs": 106,
  "observedFailure": "SIMULATED_PUBLISH_FAILURE",
  "finalState": {
    "operationStatus": "SUCCEEDED",
    "instanceStatus": "RUNNING",
    "outboxStatus": "PUBLISHED",
    "outboxRetryCount": 1
  },
  "result": "PASSED"
}
```

[LAB] Esse formato estruturado fornece os insumos necessários para futuras automações de IA (AI-02) auditarem tempo de recuperação (*Mean Time to Recover - MTTR* de laboratório), taxa de degradação e integridade de domínio sem depender de logs brutos não estruturados.

---

## 5. Limitações conscientes do LAB-06

- **Simulação local**: ambiente operando em containers Docker locais; ausência de partições de rede físicas entre múltiplos datacenters.
- **Topologia de nó único**: PostgreSQL em instância primária única (sem réplica síncrona/streaming replication) e NATS em nó único com JetStream ativado (sem cluster Raft de 3 nós).
- **Sem Dead Letter Queue (DLQ) automática**: eventos que excedam tentativas máximas permanecem no banco para diagnóstico, sem roteamento para tópicos DLQ.
- **Sem observabilidade distribuída**: não inclui OpenTelemetry collector, tracing Jaeger ou alertas Prometheus.
