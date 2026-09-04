# AI-01 — QE Intelligence Layer consultiva

## Objetivo e autoridade

- [LAB] A QE Intelligence Layer analisa mudanças de Pull Request e sugere riscos, controles afetados, gaps, checks e perguntas para revisão humana.
- [LAB] A saída é probabilística e consultiva. Ela não aprova ou reprova PR, não altera código, testes ou riscos, não executa comandos e não substitui controles determinísticos.
- [LAB] A decisão continua humana: `Risco -> Controle -> Evidência -> Decisão humana`.

## Arquitetura implementada

```text
PR diff + catálogo de riscos + resultado resumido dos controles
                            |
                            v
             coletor determinístico e limitado
                            |
                            v
                 interface AiProvider
                            |
                            v
             OpenAiProvider (primeiro adapter)
                            |
                            v
              JSON validado pelo schema local
                            |
                            v
          GITHUB_STEP_SUMMARY -> revisão humana
```

| Componente | Responsabilidade |
|---|---|
| `tools/impact-context.ts` | identifica arquivos, aplica mapeamentos conhecidos, limita e redige o diff e separa mudanças OpenAPI |
| `tools/ai/provider.ts` | define `AiProvider` e o contrato neutro de indisponibilidade |
| `tools/ai/openai-provider.ts` | usa OpenAI Responses API com Structured Outputs, sem expor tipos do SDK ao domínio |
| `tools/ai/schema.ts` | valida localmente todos os campos e enums do advisory |
| `tools/ai/advisory-analysis.ts` | resume controles, versiona o prompt, aplica timeout/fallback e formata o summary legível |

## Fluxo no GitHub Actions

1. [LAB] `ai-advisory-control-results` executa os testes do PR sem acesso a `OPENAI_API_KEY` e disponibiliza o relatório por um dia.
2. [LAB] `ai-quality-advisory` usa o analyzer da base confiável do PR e busca o head somente para calcular o diff; o código alterado não é executado no passo que recebe o secret.
3. [LAB] O contexto determinístico reúne arquivos alterados, diff relevante, riscos/controles conhecidos, resumo dos testes e diff OpenAPI quando aplicável.
4. [LAB] O adapter envia esse contexto mínimo à OpenAI e solicita JSON estruturado.
5. [LAB] O schema local valida a resposta antes da publicação no `GITHUB_STEP_SUMMARY`.
6. [LAB] Os jobs consultivos não dependem de `deterministic-quality-gate`, e todos os seus pontos de falha são não bloqueantes.

## Contrato da saída

```json
{
  "impact": "MEDIUM",
  "impactedRisks": [
    {
      "subject": "RISK-API-005",
      "rationale": "A mudança toca a identidade reutilizada em retries",
      "evidence": ["apps/control-plane-mock/src/store.ts"]
    }
  ],
  "impactedControls": [],
  "coverageGaps": [],
  "suspiciousTests": [],
  "securityConcerns": [],
  "recommendedChecks": [
    {
      "subject": "Reexecutar concorrência",
      "rationale": "O controle reduz o risco de provisionamento duplicado",
      "evidence": ["CTRL-DUPLICATE-001"]
    }
  ],
  "humanQuestions": [],
  "confidence": "HIGH"
}
```

Cada item contém assunto, justificativa e uma lista de evidências. A lista pode ficar vazia somente quando não houver origem rastreável no contexto recebido.

## Fallback e limites

- [LAB] Chave ausente, provider indisponível, timeout, falha de rede ou resposta inválida resulta em `AI_ADVISORY_UNAVAILABLE` e na mensagem “AI Advisory indisponível — Quality Gate não afetado.”
- [LAB] A chave é lida somente de `OPENAI_API_KEY`. Nenhuma chave, `.env`, token, resposta de API ou header de autorização é versionado.
- [LAB] Caminhos com indícios de segredo são excluídos; padrões comuns de credencial são redigidos antes do envio.
- [LAB] O diff é limitado a 12 arquivos relevantes, 2.800 caracteres por arquivo e 16.000 caracteres no total. Mudança OpenAPI recebe seção própria limitada a 5.000 caracteres; lockfiles são listados, mas seu conteúdo não é enviado.
- [LAB] O resultado de testes enviado contém apenas totais, duração, nomes e status de até 50 controles; logs e erros completos não são enviados.
- [LAB] O output do modelo é limitado a 1.800 tokens e a chamada não habilita ferramentas nem armazenamento explícito da Response (`store: false`).

## Modelo e custo

- [LAB] O modelo default do adapter é `gpt-5.4-mini`; a seleção pode ser alterada por `QE_AI_MODEL` sem mudar o domínio.
- [PUB] A documentação oficial registra o modelo como uma opção mini para alto volume, com suporte a Responses API e Structured Outputs: [GPT-5.4 Mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini).
- [LAB] O custo é contido por uma chamada por execução em PR, prompt curto, diff filtrado/truncado, ausência do repositório completo, saída limitada e nenhum retry automático do SDK.
- [LAB] Mudança de modelo deve ser revisada quanto a suporte a Structured Outputs, preço, latência e limites antes de alterar a variável do repositório.

## Execução local

Sem chave, o comando exercita o fallback seguro:

```bash
npm run ai:advisory
npm run ai:failure-advisory
```

Com uma chave fornecida apenas pelo ambiente:

```bash
export OPENAI_API_KEY
QE_AI_MODEL=gpt-5.4-mini npm run ai:advisory
QE_AI_MODEL=gpt-5.4-mini npm run ai:failure-advisory
```

O contexto determinístico continua disponível separadamente:

```bash
npm run impact:context
npm run impact:context -- --format json
```

## AI-02 — Failure Intelligence

### Objetivo

[LAB] Evoluir a QE Intelligence Layer para analisar evidências reais de resiliência e recuperação distribuída geradas pelo LAB-06 (`evidence/resiliency/*.json`), auxiliando o Quality Engineer a avaliar a degradação, gaps de cobertura e riscos residuais.

### Dados ingeridos

1. **Evidências de resiliência normalizadas:** `evidence/resiliency/*.json` com `scenario`, `riskId`, `controlId`, `observedFailure`, `startedAt`, `recoveredAt`, `durationMs`, `finalState` e `result`.
2. **Métricas determinísticas locais:** calculadas antes da invocação do modelo (totais, taxa de sucesso, duração mín/máx/média, riscos e falhas observadas).
3. **Contexto de PR:** diff relevante, riscos mapeados e resumo de execução dos testes.

### Métricas determinísticas locais

[LAB] A LLM não é solicitada a realizar cálculos aritméticos. O carregador (`tools/ai/evidence-loader.ts`) calcula deterministicamente:
- total de cenários e status (`passed` / `failed`);
- tempo de recuperação (`min`, `max`, `avg`);
- conjunto consolidado de riscos e controles exercitados;
- catálogo de falhas observadas durante a degradação.

### Papel da LLM

- sintetizar o comportamento do sistema durante a falha (`failureSummary`);
- avaliar a consistência da recuperação (`recoveryAssessment`: `RECOVERED_CONSISTENT`, `RECOVERED_DEGRADED`, `RECOVERY_FAILED`, `INCONCLUSIVE`);
- apontar preocupações de consistência e integridade (`consistencyConcerns`);
- identificar padrões recorrentes entre execuções (`recurringPatterns`);
- sinalizar gaps de cobertura de teste (`coverageGaps`);
- sugerir novos experimentos de resiliência e caos (`recommendedExperiments`);
- elaborar perguntas orientadas à revisão humana (`humanQuestions`).

### Regras e guardrails estritos

- **Diferenciação obrigatória:** a IA deve distinguir explicitamente evidência observada, inferência e ausência de cobertura.
- **Vedação de afirmações categóricas sem evidência:** a IA está proibida de afirmar que o sistema é "resiliente" de forma ampla; qualquer qualificação é estritamente limitada aos cenários e invariantes executados.
- **Exigência de citação de evidência:** todo finding deve conter `subject`, `rationale` e lista de `evidence` (identificadores de risco, arquivo ou cenário).
- **Sem autoridade de release:** a saída é puramente consultiva e não bloqueia o Quality Gate (`AI_FAILURE_ADVISORY_UNAVAILABLE` em caso de indisponibilidade).

### Exemplo de advisory gerado

```json
{
  "failureSummary": "Os 6 cenários de falha recuperaram o estado final esperado de forma consistente sob partição NATS, falha de worker e redelivery.",
  "affectedRisks": [
    {
      "subject": "RISK-RES-001",
      "rationale": "Broker indisponível reteve mensagem no Outbox e concluiu após restabelecimento",
      "evidence": ["nats-outage-during-publish.json"]
    }
  ],
  "recoveryAssessment": "RECOVERED_CONSISTENT",
  "consistencyConcerns": [],
  "recurringPatterns": [
    {
      "subject": "Recuperação célere com Toxiproxy",
      "rationale": "A reconexão e republicação ocorreram em menos de 100ms em todos os testes",
      "evidence": ["durationMs < 100"]
    }
  ],
  "coverageGaps": [
    {
      "subject": "Partição prolongada superior à janela de deduplicação",
      "rationale": "Não há teste com partição de rede que exceda os 2 minutos da janela nativa do JetStream",
      "evidence": ["docs/05-outbox-nats.md"]
    }
  ],
  "recommendedExperiments": [
    {
      "subject": "Injeção de latência com jitter",
      "rationale": "Testar latência intermediária de 500ms antes de corte abrupto da conexão",
      "evidence": ["CTRL-RES-NATS-OUTAGE-001"]
    }
  ],
  "humanQuestions": [
    {
      "subject": "Qual a política de retenção para eventos PENDING com retryCount elevado?",
      "rationale": "Definir se deve existir alerta ou descarte seguro após N tentativas",
      "evidence": ["apps/control-plane-mock/src/outbox-publisher.ts"]
    }
  ],
  "confidence": "HIGH"
}
```

## AI-03 — Telemetry & Trace Intelligence

### Objetivo

[LAB] Evoluir a QE Intelligence Layer para correlacionar evidências de traces distribuídos OpenTelemetry (`evidence/observability/*.json`), métricas agregadas de baixa cardinalidade, resultados de resiliência (`evidence/resiliency/*.json`) e alterações de código no PR.

O objetivo é fornecer ao Quality Engineer diagnóstico assistivo, identificando pontos prováveis de degradação, spans afetados, anomalias em métricas e gaps de instrumentação, preservando sempre a decisão de qualidade como estritamente humana.

### Dados ingeridos

1. **Evidências de observabilidade normalizadas:** `evidence/observability/*.json` contendo `traceId`, `correlationId`, lista de `spansObserved` (com `name`, `spanId`, `parentSpanId`, `status`, `attributes`), `metricsObserved` e `observedIssue`.
2. **Evidências de resiliência:** `evidence/resiliency/*.json` com falhas simuladas e durações de recuperação.
3. **Métricas determinísticas agregadas:** calculadas deterministicamente em TypeScript antes da invocação da LLM.
4. **Contexto de PR:** diff relevante limitado, riscos mapeados no catálogo e resumo de controles do Playwright.

### Correlação determinística antes da IA

[LAB] A LLM não realiza cálculos aritméticos nem deduções de conjuntos que possam ser resolvidos programaticamente. O módulo `tools/ai/telemetry-evidence-loader.ts` calcula antes da chamada:
- contagem total de traces e cenários analisados;
- conjunto unificado de spans observados na cadeia (`http.request`, `db.transaction.create_instance`, `outbox.create_event`, `nats.publish`, `nats.consume`, `db.transaction.update_state`);
- identificação exata de quebras de fluxo (cenários onde spans esperados estão ausentes);
- catálogo de traces e spans com status `ERROR`;
- agregação das métricas essenciais (`http_requests_total`, `http_errors_total`, `outbox_pending_count`, `outbox_publish_failures_total`, `messages_processed_total`, `consumer_failures_total`, `message_redeliveries_total`);
- catálogo unificado de riscos e controles exercitados;
- estatísticas de tempo de recuperação (`min`, `max`, `avg`).

### Regra rígida anti-alucinação: OBSERVED vs. INFERRED vs. GAP

Para prevenir falsas afirmações e garantir rigor investigativo, todo item retornado pela IA (`finding`) possui obrigatoriamente o atributo `classification`:

- **`OBSERVED`**: Fato concreto diretamente verificável nos artefatos.
  *Exemplo:* O span `nats.publish` apresentou status `ERROR` e `outbox_publish_failures_total` incrementou em 1.
- **`INFERRED`**: Hipótese provável fundamentada na correlação lógica de múltiplos sinais observados.
  *Exemplo:* A degradação provavelmente ocorreu na fronteira de conectividade entre o Outbox Publisher e o broker NATS JetStream.
- **`GAP`**: Ausência de evidência, métrica ou rastreabilidade requerida para diagnóstico completo.
  *Exemplo:* Não há medição de latência intermediária ou jitter antes do corte abrupto da conexão.

### Proibição de causa raiz categórica

[LAB] A IA é estritamente proibida de declarar que qualquer componente foi a "causa raiz definitiva" sem prova matemática/determinística cabal. Declarações hipotéticas devem ser explicitamente qualificadas como `INFERRED`.

### Identificação de gaps de instrumentação

A camada identifica oportunidades de aprimoramento na cobertura de observabilidade:
- novas rotas HTTP ou operações sem span correspondente;
- ausência de propagação de `correlationId` em fronteiras de mensageria;
- spans esperados que não foram emitidos durante execuções anômalas;
- métricas cujos contadores não refletiram eventos funcionais ocorridos.

### Contrato da saída estruturada

```json
{
  "executiveSummary": "A cadeia de telemetria registrou os 6 spans essenciais com propagação íntegra de traceId W3C e isolamento de erros sob indisponibilidade do broker.",
  "probableDegradationPoints": [
    {
      "subject": "Fronteira Publisher -> NATS JetStream",
      "rationale": "O span nats.publish registrou status ERROR durante corte temporário de rede",
      "evidence": ["nats.publish spanId: d5289be0b39c6e94", "outbox_publish_failures_total: 1"],
      "classification": "OBSERVED"
    },
    {
      "subject": "Retenção no PostgreSQL Outbox",
      "rationale": "A falha na publicação causou retenção temporária do evento como PENDING sem perda transacional",
      "evidence": ["outbox_pending_count: 1", "scenario-4-nats-publish-failure.json"],
      "classification": "INFERRED"
    }
  ],
  "affectedRisks": [
    {
      "subject": "RISK-OBS-004",
      "rationale": "Falha de mensageria foi diagnosticada no span e contadores sem perda silenciosa",
      "evidence": ["CTRL-OBS-NATS-ERROR-VISIBILITY-001"],
      "classification": "OBSERVED"
    }
  ],
  "traceFindings": [
    {
      "subject": "Árvore de spans completa no fluxo nominal",
      "rationale": "Os 6 spans conectaram-se causalmente mantendo o mesmo traceId",
      "evidence": ["scenario-1-provisioning-trace.json"],
      "classification": "OBSERVED"
    }
  ],
  "metricFindings": [
    {
      "subject": "Sincronia estrita entre erros de span e métricas",
      "rationale": "outbox_publish_failures_total incrementou em concordância exata com o span ERROR",
      "evidence": ["outbox_publish_failures_total = 1"],
      "classification": "OBSERVED"
    }
  ],
  "instrumentationGaps": [
    {
      "subject": "Ausência de métrica de tempo de conexão TCP/TLS ao NATS",
      "rationale": "Não há telemetria da latência de handshake antes da falha de publicação",
      "evidence": ["docs/07-observability-telemetry.md"],
      "classification": "GAP"
    }
  ],
  "consistencyConcerns": [],
  "recommendedInvestigations": [
    {
      "subject": "Avaliar saturação de pool de conexões sob retentativas de publicação",
      "rationale": "Verificar se retries excessivos causam contenção no PostgreSQL",
      "evidence": ["postgres-store.ts"],
      "classification": "INFERRED"
    }
  ],
  "recommendedTests": [
    {
      "subject": "Teste de injeção de jitter na conexão NATS",
      "rationale": "Avaliar preservação do contexto W3C sob latência variável",
      "evidence": ["CTRL-RES-NATS-OUTAGE-001"],
      "classification": "GAP"
    }
  ],
  "humanQuestions": [
    {
      "subject": "Qual o limiar seguro de outbox_pending_count para acionamento de alerta?",
      "rationale": "Importante para definir alertas preventivos de QE em ambientes compartilhados",
      "evidence": ["telemetry.ts"],
      "classification": "GAP"
    }
  ],
  "confidence": "HIGH"
}
```

## AI-04 — Journey Intelligence

### Objetivo

[LAB] Evoluir a QE Intelligence Layer para analisar evidências reais de jornadas sintéticas completas de ponta a ponta (`evidence/journeys/*.json`), correlacionando-as deterministicamente com traces OpenTelemetry (`evidence/observability/*.json`), falhas de resiliência (`evidence/resiliency/*.json`) e alterações de código no PR.

A inteligência de jornadas visa responder ao Quality Engineer:
- quais jornadas completaram com sucesso ou sofreram degradação;
- quais SLAs sintéticos de referência foram atendidos ou violados;
- onde provavelmente ocorreram os gargalos na esteira assíncrona;
- quais traces, spans e falhas de resiliência sustentam as hipóteses;
- quais riscos de negócio e técnicos foram efetivamente exercitados;
- quais gaps de teste ou instrumentação permanecem em aberto;
- quais investigações e testes adicionais são recomendados.

### Dados ingeridos

1. **Evidências de jornadas sintéticas normalizadas:** `evidence/journeys/*.json` contendo `journey`, `riskId`, `controlId`, `startedAt`, `acceptedAt`, `completedAt`, `apiLatencyMs`, `endToEndDurationMs`, `recoveryDurationMs`, `traceId`, `correlationId`, `retries`, `redeliveries`, `finalState`, `slaAssessment` e `result`.
2. **Evidências de observabilidade:** `evidence/observability/*.json` com árvore de spans e status de erro.
3. **Evidências de resiliência:** `evidence/resiliency/*.json` com falhas simuladas e janelas de recuperação.
4. **Métricas determinísticas locais:** agregadas em TypeScript antes da invocação do modelo.
5. **Contexto de PR:** diff relevante, riscos mapeados no catálogo e resumo de controles do Playwright.

### Correlação determinística antes da IA

[LAB] A LLM não realiza cálculos aritméticos nem deduções numéricas. O módulo `tools/ai/journey-evidence-loader.ts` calcula deterministicamente:
- contagem total de jornadas e conformidade (`passed` / `failed`);
- contadores de SLA sintético (`MET` / `BREACHED`);
- estatísticas de latência de aceitação da API (`min`, `max`, `avg`);
- estatísticas de duração E2E completa (`min`, `max`, `avg`);
- estatísticas de duração de recuperação pós-falha (`min`, `max`, `avg`);
- total acumulado de retries de cliente e redeliveries do broker;
- identificação unívoca da jornada mais lenta e sua duração;
- catálogo consolidado de riscos e controles exercitados;
- lista unificada de `traceIds` e `correlationIds` associados;
- correlação entre cada jornada e eventuais spans em `ERROR` ou falhas simuladas;
- detecção de variações anormais de latência ou retries se houver múltiplos registros da mesma jornada.

### Regras rígidas e guardrails anti-alucinação

- **Classificação obrigatória por item (`OBSERVED`, `INFERRED`, `GAP`):**
  - **`OBSERVED`**: Evidência direta e mensurada nos JSONs (ex: `apiLatencyMs = 43ms`, `slaAssessment = MET`, span `nats.publish` com erro).
  - **`INFERRED`**: Hipótese provável sustentada pela correlação lógica de múltiplos sinais (ex: maior duração associada à recuperação da conexão NATS).
  - **`GAP`**: Ausência de métrica, baseline histórico ou cenário de teste.
- **Vedação de afirmações genéricas de desempenho:** A IA está proibida de afirmar que "o sistema está performático" ou que "atende SLA de produção". Deve utilizar formulações circunscritas: *"as N jornadas sintéticas executadas ficaram dentro dos limites [LAB] definidos"*.
- **Proibição de causa raiz definitiva sem evidência direta:** Hipóteses de gargalo devem ser sempre qualificadas como `INFERRED`.
- **Diferença entre SLA sintético e SLA real:** Os SLAs do laboratório (`LAB_SYNTHETIC_SLA`) são limites simulados locais para detecção de anomalias na suíte de testes, não correspondendo a SLAs contratuais de produção da TOTVS.
- **Sem autoridade de release:** A análise é puramente consultiva e não bloqueia o Quality Gate (`AI_JOURNEY_ADVISORY_UNAVAILABLE` em caso de indisponibilidade).

### Exemplo de advisory gerado

```json
{
  "executiveSummary": "As 4 jornadas sintéticas executadas ficaram dentro dos limites [LAB] definidos, com convergência atômica após retentativas e falhas simuladas.",
  "degradedJourneys": [],
  "slaFindings": [
    {
      "subject": "Conformidade integral de SLA nominal",
      "rationale": "Todas as jornadas cumpriram os limites máximos de 500ms de API e 5000ms de E2E",
      "evidence": ["journey-1-successful-provisioning.json", "apiLatencyMs <= 43"],
      "classification": "OBSERVED"
    }
  ],
  "probableBottlenecks": [
    {
      "subject": "Recuperação do worker publisher sob partição NATS",
      "rationale": "A jornada com falha transitória do broker apresentou a maior duração E2E (198ms)",
      "evidence": ["journey-3-transient-nats-failure-recovery.json"],
      "classification": "INFERRED"
    }
  ],
  "affectedRisks": [
    {
      "subject": "RISK-JOURNEY-001",
      "rationale": "Ciclo completo de provisionamento validado de ponta a ponta",
      "evidence": ["CTRL-JOURNEY-PROVISIONING-001"],
      "classification": "OBSERVED"
    }
  ],
  "traceCorrelations": [
    {
      "subject": "Propagação unificada do traceId W3C",
      "rationale": "Os 6 spans da esteira conectaram-se causalmente mantendo o mesmo identificador",
      "evidence": ["traceId: a50d17714183daecaf379897b3527ebb"],
      "classification": "OBSERVED"
    }
  ],
  "resilienceCorrelations": [
    {
      "subject": "Convergência após redelivery com NAK",
      "rationale": "O consumidor rejeitou mensagem com erro simulado e concluiu com sucesso na reentrega",
      "evidence": ["journey-4-consumer-failure-redelivery.json"],
      "classification": "OBSERVED"
    }
  ],
  "coverageGaps": [
    {
      "subject": "Ausência de baseline histórico persistido",
      "rationale": "Não há repositório temporal de métricas para calcular desvio padrão entre commits",
      "evidence": ["docs/08-synthetic-journeys.md"],
      "classification": "GAP"
    }
  ],
  "recommendedInvestigations": [
    {
      "subject": "Avaliar tempo de reconexão NATS com latências intermediárias",
      "rationale": "Medir comportamento do publisher com Toxiproxy sob latência gradual",
      "evidence": ["tests/helpers/toxiproxy.ts"],
      "classification": "INFERRED"
    }
  ],
  "recommendedTests": [
    {
      "subject": "Jornada combinada de falha simultânea de publisher e consumer",
      "rationale": "Validar idempotência e integridade quando ambas as pontas sofrem degradação concorrente",
      "evidence": ["CTRL-JOURNEY-BROKER-RECOVERY-001", "CTRL-JOURNEY-CONSUMER-REDELIVERY-001"],
      "classification": "GAP"
    }
  ],
  "humanQuestions": [
    {
      "subject": "Qual o percentual de variação aceitável em E2E antes de considerar regressão?",
      "rationale": "Importante para configurar regras de alerta em execuções contínuas de CI",
      "evidence": ["LAB_SYNTHETIC_SLA"],
      "classification": "GAP"
    }
  ],
  "confidence": "HIGH"
}
```

## Governança

- [LAB] O Quality Gate usa somente build, typecheck, OpenAPI e testes determinísticos.
- [LAB] Nenhum nível de impacto ou confiança da LLM muda status de job bloqueante.
- [LAB] O summary identifica provider, modelo e versão pública do prompt (`qe-advisory-v1`, `qe-failure-advisory-v1`, `qe-telemetry-advisory-v1`, `qe-journey-advisory-v1`) para auditoria humana.
- [LAB] Diff e relatórios são entradas não confiáveis: instruções contidas neles devem ser ignoradas pelo modelo.
- [LAB] A utilidade será avaliada por revisão humana e gaps encontrados, nunca por taxa de “aprovação”.
- [LAB] Prompts não devem conter segredos; mudanças no prompt curto e público passam por revisão de código.

## Referências

- [PUB] A documentação oficial da OpenAI descreve Structured Outputs e integração com Zod no SDK JavaScript: [Structured model outputs](https://developers.openai.com/api/docs/guides/structured-outputs).
- [PUB] A documentação oficial registra suporte do `gpt-5.4-mini` à Responses API e Structured Outputs: [GPT-5.4 Mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini).
- [PUB] A documentação oficial recomenda carregar a chave da API por variável de ambiente: [Developer quickstart](https://platform.openai.com/docs/quickstart/make-your-first-api-request).
