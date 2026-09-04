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

## Governança

- [LAB] O Quality Gate usa somente build, typecheck, OpenAPI e testes determinísticos.
- [LAB] Nenhum nível de impacto ou confiança da LLM muda status de job bloqueante.
- [LAB] O summary identifica provider, modelo e versão pública do prompt (`qe-advisory-v1`) para auditoria humana.
- [LAB] Diff e relatórios são entradas não confiáveis: instruções contidas neles devem ser ignoradas pelo modelo.
- [LAB] A utilidade será avaliada por revisão humana e gaps encontrados, nunca por taxa de “aprovação”.
- [LAB] Prompts não devem conter segredos; mudanças no prompt curto e público passam por revisão de código.

## Referências

- [PUB] A documentação oficial da OpenAI descreve Structured Outputs e integração com Zod no SDK JavaScript: [Structured model outputs](https://developers.openai.com/api/docs/guides/structured-outputs).
- [PUB] A documentação oficial registra suporte do `gpt-5.4-mini` à Responses API e Structured Outputs: [GPT-5.4 Mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini).
- [PUB] A documentação oficial recomenda carregar a chave da API por variável de ambiente: [Developer quickstart](https://platform.openai.com/docs/quickstart/make-your-first-api-request).
