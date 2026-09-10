# Arquitetura Consolidada do Laboratório — LAB-12

> [LAB] Laboratório pessoal, público e não oficial de Quality Engineering aplicado a Cloud. Não representa arquitetura, produtos, contratos ou decisões da TOTVS.

---

## 1. Fluxo Ponta a Ponta de Qualidade

```text
+-------------------------------------------------------------------------------------------------------------+
|                                             SISTEMA SOB TESTE                                               |
|                                                                                                             |
|    [ 1. API ]                                                                                               |
|         |                                                                                                   |
|         v (transação ACID atômica)                                                                          |
|    [ 2. PostgreSQL ] ----------------------------+                                                          |
|         | (estado de instâncias)                 | (eventos pendentes)                                      |
|         v                                        v                                                          |
|    [ Instâncias ]                       [ 3. Outbox Table ]                                                 |
|                                                  |                                                          |
|                                                  v (polling assíncrono seguro)                              |
|                                         [ Outbox Publisher ]                                                |
|                                                  |                                                          |
|                                                  v (publish confiável)                                      |
|                                         [ 4. NATS JetStream ]                                               |
|                                                  |                                                          |
|                                                  v (at-least-once delivery)                                 |
|                                         [ 5. Consumer Idempotente ]                                         |
|                                                  |                                                          |
|                                                  v (conclusão assíncrona)                                   |
|                                         [ Operações Concluídas ]                                            |
+--------------------------------------------------+----------------------------------------------------------+
                                                   |
                                                   v
+-------------------------------------------------------------------------------------------------------------+
|                                            MALHA DE QUALIDADE                                               |
|                                                                                                             |
|    [ 6. Observability ]    [ 7. Journeys ]       [ 8. Performance ]    [ 9. Security ]                      |
|    - 6 spans OpenTelemetry - 4 jornadas E2E      - k6 concorrência     - TruffleHog (secrets)               |
|    - Rastreamento W3C      - SLAs sintéticos     - Baseline 20%        - npm audit (deps)                   |
|    - OTel Collector/Jaeger - Retries/Redelivery  - Corrida idempotente - Semgrep (SAST)                     |
|    - Métricas QE           - Validação atômica   - Latência p95/p99    - OWASP ZAP (DAST)                   |
+--------------------------------------------------+----------------------------------------------------------+
                                                   |
                                                   v
+-------------------------------------------------------------------------------------------------------------+
|                                    SÍNTESE, HISTÓRICO E GOVERNANÇA                                          |
|                                                                                                             |
|    [ 10. Evidências Normalizadas ]                                                                          |
|    - Arquivos JSON estruturados (evidence/history, journeys, performance, resiliency, security)             |
|         |                                                                                                   |
|         v                                                                                                   |
|    [ 11. Scorecard Executivo ]                                                                              |
|    - 9 dimensões avaliadas deterministicamente (GREEN / YELLOW / RED / UNKNOWN)                             |
|    - Série temporal baseada em checkpoints versionados (>= 3 snapshots para tendência)                      |
|    - Publicação em JSON, Markdown executivo, HTML A4 landscape e PDF executivo                              |
|         |                                                                                                   |
|         v                                                                                                   |
|    [ 12. QE Intelligence Layer ]                                                                            |
|    - Análises consultivas de impacto, falhas, telemetria, jornadas, segurança e regressões (AI-01 a AI-07)  |
|    - Structured Outputs (Zod), classificação OBSERVED / INFERRED / GAP e guardrails estritos anti-alucinação|
|         |                                                                                                   |
|         v                                                                                                   |
|    [ 13. Decisão Humana ]                                                                                   |
|    - Quality Gate determinístico com bloqueio objetivo em CI                                                |
|    - Revisão e autoridade de release 100% humana (Risco -> Controle -> Evidência -> Decisão humana)         |
+-------------------------------------------------------------------------------------------------------------+
```

---

## 2. Descrição de Cada Bloco

1. **API (Contrato & Entrada):** Ponto de entrada HTTP do Cloud Control Plane fictício com especificação OpenAPI 3.1, validação de schemas, cabeçalhos diagnósticos W3C e garantias de idempotência via `Idempotency-Key`.
2. **PostgreSQL (Persistência Transacional):** Banco relacional responsável por armazenar instâncias e registrar eventos de domínio atomicamente na mesma transação ACID, impedindo estados fantasmas.
3. **Outbox Table & Publisher:** Implementação do padrão Transactional Outbox; desacopla a persistência relacional do envio de mensagens, garantindo tolerância a falhas na publicação sem perda de dados.
4. **NATS JetStream (Mensageria Distribuída):** Broker com persistência baseada em stream e semântica de entrega *at-least-once*, configurado para entrega resiliente sob falhas e reinicializações.
5. **Consumer Idempotente:** Worker que processa eventos assíncronos registrando identificadores em tabela de deduplicação relacional (`processed_events`), garantindo ausência de mutações espúrias mesmo sob redeliveries.
6. **Observability (Telemetria & Tracing):** Instrumentação OpenTelemetry cobrindo os 6 spans do ciclo assíncrono com propagação de contexto W3C, métricas QE de baixa cardinalidade, OTel Collector e Jaeger local.
7. **Journeys (Jornadas Sintéticas E2E):** Quatro jornadas automatizadas que exercitam o ciclo de vida completo do recurso e validam conformidade contra SLAs didáticos do laboratório.
8. **Performance (Carga & Baseline):** Testes de concorrência e capacidade com k6, comparador determinístico contra baseline de referência com tolerância de 20% e monitoramento de latências p95 e p99.
9. **Security (Segurança Preventiva):** Quatro scanners determinísticos locais (TruffleHog, npm audit, Semgrep e OWASP ZAP Baseline) com normalização comum de findings e testes comportamentais de API.
10. **Evidence (Repositório de Evidências):** Artefatos JSON estruturados gerados deterministicamente pelas suítes de teste para consumo pelo scorecard, histórico e camadas consultivas de inteligência.
11. **Scorecard (Scorecard Executivo Multidimensional):** Consolidador determinístico que avalia a saúde de 9 dimensões de qualidade, suporta série histórica ($\ge 3$ checkpoints) e gera relatórios em JSON, Markdown, HTML e PDF de 2 páginas A4 landscape.
12. **QE Intelligence Layer (IA Assistiva Consultiva):** Conjunto de automações (AI-01 a AI-07) baseadas em OpenAI com Structured Outputs Zod que analisa mudanças, falhas, telemetria, jornadas, segurança e tendências sem autoridade de gate.
13. **Human Decision (Governança & Decisão Humana):** Quality Gate bloqueante estritamente determinístico no CI; nenhuma IA aprova ou reprova releases, mantendo a responsabilidade integral nas mãos de profissionais de engenharia.
