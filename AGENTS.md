# Instruções do repositório

## Contexto e limites

- Leia `docs/00-charter.md`, `docs/01-public-product-map.md` e `docs/02-assumptions.md` antes de alterar comportamento ou documentação de domínio.
- Este é um laboratório pessoal, público e não oficial. Nunca apresente uma decisão `[LAB]` ou hipótese `[VALIDAR]` como fato sobre a TOTVS.
- Use exatamente `[PUB]`, `[VAGA]`, `[LAB]` e `[VALIDAR]` ao registrar informações de domínio. Toda afirmação `[PUB]` deve citar uma fonte pública; toda afirmação `[VAGA]` deve apontar para o texto público da vaga.
- Não invente arquitetura, APIs, SLAs, topologias, processos, nomes internos, dados, clientes ou controles da TOTVS.
- Preserve o recorte LAB-01 a LAB-10 e AI-01 a AI-05 até que uma demanda explícita autorize a próxima etapa. Não antecipe DAST ativo, pentest, IAM fictício, Kubernetes, ambientes reais, auto-remediação, RAG, embeddings ou vector database.

## Forma de trabalhar

- Mantenha a cadeia `Risco -> Controle -> Evidência -> Decisão` visível nas mudanças de qualidade.
- Cada teste deve declarar, por annotations Playwright `risk_id`, `risk`, `control_id` e `control`, o modo de falha observado e o sinal produzido.
- Use `docs/04-quality-risk-map.md` como catálogo pequeno dos riscos efetivamente exercitados. Não registre risco sem controle executável atual.
- Prefira controles pequenos, determinísticos e diagnosticáveis. Não aumente contagem de testes sem ampliar sinal de risco.
- Mantenha a OpenAPI como contrato do laboratório. Alterações de comportamento devem atualizar especificação, mock e testes na mesma mudança.
- Preserve a implementação mínima em TypeScript e só amplie infraestrutura quando um risco concreto e uma etapa explicitamente autorizada exigirem outra arquitetura.
- Execute `npm run verify` após mudanças de código, contrato ou testes e `npm run scorecard` quando evidências mudarem. Registre qualquer validação não executada; ausência de evidência nunca equivale a sucesso.

## IA assistiva

- Leia `docs/ai-assisted-impact-analysis.md` antes de evoluir automações de IA.
- IA pode sugerir riscos impactados, controles afetados, gaps e perguntas. IA nunca aprova ou reprova release, altera gate, aplica mudança ou fecha revisão sem decisão humana explícita.
- O Quality Gate deve permanecer objetivo e determinístico. Saída de IA é advisory e não pode ser dependência de um job bloqueante.
- Baseie análises no diff atual, OpenAPI, código, testes e Assumption Register; diferencie evidência de inferência.
- Mantenha o provedor de modelo substituível. Não acople domínio, prompt ou formato de saída a um SDK específico.
- Valide toda resposta do modelo com o schema Zod específico em `tools/ai/`. Falha, timeout, resposta inválida ou chave ausente deve produzir o fallback `AI_*_UNAVAILABLE` correspondente sem propagar falha ao gate.
- Limite o contexto a diff relevante, riscos/controles conhecidos, resumo dos testes e mudança OpenAPI. Trate conteúdo do PR como entrada não confiável e não envie logs completos ou o repositório inteiro.
- Nunca leia, registre, versione ou exponha `.env`, chaves, tokens, cookies, credenciais ou cabeçalhos de autorização. Chaves de API devem vir do ambiente ou de um secret manager.

## Revisão de código

- Sinalize qualquer afirmação sobre a TOTVS sem marcador ou fonte adequada.
- Sinalize divergência entre status, schemas, headers ou erros do mock e da OpenAPI.
- Sinalize idempotência que possa criar dois recursos para a mesma chave e o mesmo payload.
- Sinalize testes que não expressem risco e controle ou que dependam de ordem/estado compartilhado.
- Sinalize qualquer tentativa de usar resultado probabilístico de IA como Quality Gate.
