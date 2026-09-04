# Arquitetura de IA assistiva para análise de impacto

## Objetivo e limite

- [LAB] A futura capacidade deve sugerir riscos impactados, testes possivelmente afetados, gaps e perguntas para revisão humana.
- [LAB] A saída é consultiva e probabilística. Ela não aprova, reprova, altera código, muda testes nem compõe o resultado do Quality Gate.
- [LAB] O protótipo atual somente coleta e classifica contexto do diff de forma determinística; ele não chama modelo externo.

## Fluxo proposto

```text
diff + OpenAPI + testes + Assumption Register
                  |
                  v
       coletor determinístico atual
                  |
                  v
       contexto pequeno e rastreável
                  |
                  v
   adaptador de provedor futuro (substituível)
                  |
                  v
 proposta: riscos | testes | gaps | perguntas
                  |
                  v
             revisão humana
```

## Contrato entre domínio e modelo

- [LAB] **Entrada:** arquivos alterados, trechos relevantes, riscos declarados nos testes, comandos disponíveis e hipóteses abertas.
- [LAB] **Saída:** lista estruturada com sugestão, evidência de origem, grau de incerteza e pergunta humana. A ausência de sugestão não significa ausência de risco.
- [LAB] **Adaptador:** uma interface futura deve receber o contexto neutro e devolver a saída estruturada. OpenAI API/Codex pode ser o primeiro adaptador, sem contaminar o restante do projeto com tipos proprietários.
- [LAB] **Segredos:** credenciais entram apenas por variável de ambiente ou secret manager. `.env`, prompts com segredos e respostas sensíveis não são artefatos versionáveis.
- [LAB] **Governança:** falha, indisponibilidade, timeout ou resposta inválida do modelo deve encerrar apenas a análise consultiva com estado “indisponível”.

## Protótipo atual

[LAB] `npm run impact:context` inspeciona mudanças versionadas e não versionadas, relaciona superfícies conhecidas a riscos genéricos e imprime perguntas de revisão. Em Pull Requests, o job `advisory-impact-context` publica o texto apenas no summary e usa `continue-on-error`; o job não é dependência do gate.

## Guardrails para evolução

- [LAB] Não enviar conteúdo de `.env`, secrets, tokens, credenciais ou headers de autorização.
- [LAB] Não enviar repositório inteiro quando o diff e poucos arquivos relacionados bastarem.
- [LAB] Exigir resposta estruturada e validar seu schema antes de apresentar sugestões.
- [LAB] Exibir arquivos/linhas usados como evidência e marcar inferências.
- [LAB] Medir utilidade por revisão humana e gaps encontrados, não por taxa de “aprovação”.
- [LAB] Fixar versão do prompt e registrar o provedor/modelo fora da decisão do gate.

## Referências

- [PUB] A documentação oficial do Codex descreve `AGENTS.md` como instruções persistentes de projeto: [Custom instructions with AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md).
- [PUB] A documentação oficial da OpenAI recomenda carregar chaves da API por variável de ambiente e tratá-las como segredo: [Developer quickstart](https://platform.openai.com/docs/quickstart/make-your-first-api-request).

