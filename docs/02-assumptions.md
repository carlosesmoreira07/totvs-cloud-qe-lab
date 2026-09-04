# Assumption Register

## Regra de uso

- [LAB] Toda hipótese sobre a TOTVS deve entrar nesta tabela antes de influenciar código, teste ou decisão.
- [LAB] Hipótese não validada nunca vira `[PUB]` ou `[VAGA]` por repetição.
- [LAB] A validação exige fonte pública citável ou confirmação autorizada no onboarding; informação interna não deve ser publicada aqui.
- [LAB] Se uma hipótese não for necessária para o laboratório, a ação preferida é removê-la em vez de validá-la.

## Registro ativo

| ID | Classificação | Hipótese ou limite | Risco se tratada como fato | Tratamento no laboratório | Como validar |
|---|---|---|---|---|---|
| ASM-001 | [VALIDAR] | Pode existir uma API interna para operações de infraestrutura. | Inventar contratos ou estratégia incompatíveis com a realidade. | Usar contrato totalmente fictício e nomeá-lo como `[LAB]`. | Perguntar no onboarding apenas se for relevante e permitido. |
| ASM-002 | [VALIDAR] | Operações reais de provisionamento podem ser assíncronas. | Projetar estados, polling ou timeouts fictícios como padrão corporativo. | Assincronia existe apenas para criar cenários de teste do laboratório. | Confirmar documentação e práticas autorizadas após onboarding. |
| ASM-003 | [VALIDAR] | Serviços reais podem adotar idempotência e correlation IDs. | Atribuir headers, semântica ou retenção inexistentes ao produto. | `Idempotency-Key`, `X-Correlation-Id` e `X-Request-Id` são contratos `[LAB]`. | Confirmar contratos oficiais internos, se o papel exigir acesso. |
| ASM-004 | [VALIDAR] | A estratégia real pode usar testes de contrato e Quality Gates. | Confundir portfólio pessoal com processo oficial. | Playwright e o gate deste repositório são escolhas `[LAB]`. | Conhecer o SDLC autorizado durante onboarding. |
| ASM-005 | [VALIDAR] | Mensageria, Outbox ou NATS podem ser úteis em uma evolução educacional. | Sugerir tecnologia interna ou criar complexidade sem risco comprovado. | Não implementar antes de um LAB futuro com hipótese explícita. | Validar apenas a necessidade do experimento, não presumir adoção pela TOTVS. |

## Informações da vaga

- [LAB] Nenhuma afirmação `[VAGA]` foi registrada nesta etapa porque o texto público da vaga não foi fornecido como fonte versionável.

## Histórico de decisões

| Data | ID | Decisão |
|---|---|---|
| 2026-09-03 | ASM-001..005 | [LAB] Mantidas como `[VALIDAR]`; nenhuma foi usada como fato sobre a TOTVS. |
| 2026-09-04 | ASM-005 | [LAB] Exercitada no LAB-05 como estudo educacional pessoal; mantida como `[VALIDAR]` quanto a qualquer uso real pela TOTVS. |
