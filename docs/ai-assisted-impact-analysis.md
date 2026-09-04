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
```

Com uma chave fornecida apenas pelo ambiente:

```bash
export OPENAI_API_KEY
QE_AI_MODEL=gpt-5.4-mini npm run ai:advisory
```

O contexto determinístico continua disponível separadamente:

```bash
npm run impact:context
npm run impact:context -- --format json
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
