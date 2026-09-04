# LAB-08 — Synthetic & End-to-End Control Plane Journeys

> [LAB] Documento técnico e conceitual do laboratório de testes e jornadas sintéticas de ponta a ponta aplicadas a Quality Engineering. Não representa SLAs, processos ou arquitetura da TOTVS.

---

## 1. Visão Geral

O **LAB-08** estabelece a camada de **Jornadas Sintéticas (Synthetic Journeys)** no `totvs-cloud-qe-lab`. Enquanto os laboratórios anteriores focaram em componentes individuais, contratos de interface, resiliência isolada e telemetria, o LAB-08 exercita e afere o ciclo de vida completo do ponto de vista do usuário final:

$$\text{API (HTTP)} \longrightarrow \text{PostgreSQL (ACID)} \longrightarrow \text{Outbox} \longrightarrow \text{NATS JetStream} \longrightarrow \text{Consumer} \longrightarrow \text{Estado Final} \longrightarrow \text{Telemetry} \longrightarrow \text{Evidência}$$

As perguntas centrais que o laboratório responde são:
1. **A jornada inteira funciona de forma integrada e repetível?**
2. **Quanto tempo leva a aceitação e a conclusão ponta a ponta?**
3. **Onde ocorrem degradações parciais durante a jornada?**
4. **O estado final no banco de dados e nos recursos reflete com exatidão a intenção do usuário?**
5. **Existem regressões silenciosas de latência ou inconsistências após falhas recuperadas?**

---

## 2. O que é Synthetic Testing em Quality Engineering

Em sistemas distribuídos e control planes assíncronos, testes unitários e testes de contrato de API individuais comprovam apenas o funcionamento de partes isoladas da esteira. O **Synthetic Testing** executa transações sintéticas periódicas e determinísticas que reproduzem com fidelidade os caminhos críticos do usuário:

- **Proatividade:** detecta anomalias funcionais e quebras de SLA antes que clientes reais sejam impactados;
- **Perspectiva Externa:** interage com o sistema exclusivamente através de suas fronteiras públicas (HTTP endpoints, headers, payloads e consultas de operação);
- **Determinismo Temporal:** mede a latência de cada etapa da jornada (aceitação síncrona, duração total assíncrona e tempo de recuperação).

---

## 3. Diferença entre Teste de API e Jornada Ponta a Ponta

| Dimensão | Teste de API Tradicional (LAB-03) | Jornada Sintética Ponta a Ponta (LAB-08) |
|---|---|---|
| **Escopo** | Validação pontual de request/response em um endpoint específico. | Ciclo de vida completo: criação, publicação, mensageria, consumo e consulta final. |
| **Tempo e SLA** | Mede status code imediato (ex: 202 Accepted). | Mede latência de aceitação síncrona ($\le 500\text{ms}$) e convergência total ($\le 5\text{s}$). |
| **Resiliência** | Valida retorno de erro em payloads inválidos. | Valida se a jornada sobrevive a falhas parciais (broker fora, redelivery) e converge. |
| **Idempotência** | Comprova replay da API HTTP. | Comprova que o replay cliente não gera efeitos colaterais na esteira de mensageria nem registros duplicados no banco. |
| **Telemetria** | Não inspeciona correlação distribuída. | Valida que um único `traceId` W3C atravessa todos os 6 spans da jornada. |

---

## 4. Medição Determinística de Tempos

Para eliminar arbitrariedades e apoiar diagnósticos objetivos, cada jornada calcula programaticamente em TypeScript:

1. **`apiLatencyMs`:** Intervalo entre a emissão da requisição `POST /v1/instances` e o recebimento da resposta HTTP 202 com os headers diagnósticos.
2. **`endToEndDurationMs`:** Duração total desde o disparo inicial até a operação atingir `SUCCEEDED` e a instância `RUNNING`.
3. **`recoveryDurationMs`:** Quando aplicável, o tempo transcorrido entre a injeção da falha transitória (broker ou consumer) e a convergência do estado final.

---

## 5. Definição dos SLAs Sintéticos do Laboratório

> [!IMPORTANT]
> **Metas Sintéticas Didáticas [LAB]**:
> - **API Acceptance Latency:** $\le 500\text{ ms}$
> - **Provisioning End-to-End:** $\le 5.000\text{ ms}$
> - **Transient Recovery Duration:** $\le 5.000\text{ ms}$
>
> *Esses valores são exclusivamente experimentais para o laboratório e não representam SLAs ou métricas de produção da TOTVS.*

Cada execução avalia deterministicamente as métricas e registra o parecer `slaAssessment`:
- `apiLatencyMet`: boolean
- `endToEndMet`: boolean
- `recoveryMet`: boolean
- `status`: `'MET' | 'BREACHED'`

---

## 6. As Jornadas Implementadas

### Jornada 1: Provisionamento Bem-Sucedido (`journey-1-successful-provisioning`)
- **Risco:** `RISK-JOURNEY-001` (`CTRL-JOURNEY-PROVISIONING-001`)
- **Fluxo:** Envio do `POST /v1/instances` com chave de idempotência e `correlationId` novos. Aceitação rápida ($\le 500\text{ms}$), acompanhamento assíncrono determinístico via polling sem sleep fixo até `SUCCEEDED`, verificação da instância `RUNNING`, inspeção da cadeia de 6 spans com `traceId` W3C uniforme e cumprimento do SLA total ($\le 5\text{s}$).

### Jornada 2: Retry Idempotente durante Provisionamento (`journey-2-idempotent-retry`)
- **Risco:** `RISK-JOURNEY-002` (`CTRL-JOURNEY-IDEMPOTENT-RETRY-001`)
- **Fluxo:** Submissão inicial seguida de retransmissão imediata com a mesma chave e payload. Comprova resposta 202 com idênticos `operationId` e `instanceId`, acompanhamento até `SUCCEEDED` e validação no banco relacional de que exatamente 1 registro foi criado em `instances`, `operations` e `outbox_events`.

### Jornada 3: Falha Temporária de NATS com Recuperação (`journey-3-transient-nats-failure-recovery`)
- **Risco:** `RISK-JOURNEY-003` (`CTRL-JOURNEY-BROKER-RECOVERY-001`)
- **Fluxo:** Iniciação de provisionamento com a publicação do Outbox temporariamente bloqueada. Valida desacoplamento da API (resposta aceita em $\le 500\text{ms}$), estado degradado com evento `PENDING` retido no PostgreSQL (`last_error`), restabelecimento da conectividade, publicação em retry e convergência final para `SUCCEEDED` dentro do SLA de recuperação ($\le 5\text{s}$).

### Jornada 4: Falha do Consumer com Redelivery (`journey-4-consumer-failure-redelivery`)
- **Risco:** `RISK-JOURNEY-004` (`CTRL-JOURNEY-CONSUMER-REDELIVERY-001`)
- **Fluxo:** Mensagem entregue ao consumidor com falha controlada na primeira tentativa. Valida ausência de ACK prematuro (tabela `processed_events` permanece vazia), desarme da falha simulada, recebimento do redelivery via NATS JetStream, processamento com commit atômico e convergência para `SUCCEEDED` com `redeliveries = 1`.

---

## 7. Rastreabilidade com OpenTelemetry

As jornadas correlacionam identificadores sem misturar suas finalidades:
- **`correlationId`:** identidade de negócio informada pelo cliente;
- **`traceId`:** identificador técnico W3C compartilhado por todos os spans da jornada;
- **Spans verificados:** `http.request`, `db.transaction.create_instance`, `outbox.create_event`, `nats.publish`, `nats.consume`, `db.transaction.update_state`.

---

## 8. Evidências Estruturadas (`evidence/journeys/*.json`)

Cada execução de jornada produz um arquivo JSON compacto, versionado e determinístico:

```json
{
  "journey": "journey-1-successful-provisioning",
  "riskId": "RISK-JOURNEY-001",
  "controlId": "CTRL-JOURNEY-PROVISIONING-001",
  "startedAt": "2026-09-04T06:41:16.905Z",
  "acceptedAt": "2026-09-04T06:41:17.015Z",
  "completedAt": "2026-09-04T06:41:17.161Z",
  "apiLatencyMs": 110,
  "endToEndDurationMs": 256,
  "recoveryDurationMs": null,
  "traceId": "579cb1bd8fce0537d960880212039c89",
  "correlationId": "corr-journey-eb2e48c3-1c26-4c38-9f28-db4dec8c7ef6",
  "retries": 0,
  "redeliveries": 0,
  "finalState": {
    "instanceId": "fb105900-219a-4293-8335-f841c27ef6d0",
    "operationId": "9226a7aa-1f00-483c-bb58-f2b6274c8c07",
    "instanceStatus": "RUNNING",
    "operationStatus": "SUCCEEDED"
  },
  "slaAssessment": {
    "apiLatencyMet": true,
    "endToEndMet": true,
    "recoveryMet": true,
    "status": "MET",
    "targetSla": {
      "maxApiLatencyMs": 500,
      "maxEndToEndDurationMs": 5000,
      "maxRecoveryDurationMs": 5000
    }
  },
  "result": "PASSED"
}
```

Esses artefatos alimentam o contexto de impacto e estarão disponíveis para consumo futuro pela QE Intelligence Layer (AI-04).

---

## 9. Limitações Conscientes

1. **[LAB] SLA Local:** As metas sintéticas são aferidas em ambiente local e no GitHub Actions; não representam compromissos contratuais de produto.
2. **[LAB] Amostragem Determinística:** Não há gerador contínuo de tráfego de carga ou estresse nesta etapa.
3. **[LAB] Simulação Controlada:** Falhas de rede e worker são injetadas de forma controlada via flags programáticas e Toxiproxy, garantindo determinismo nos testes de CI.
