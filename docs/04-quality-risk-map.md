# Mapa de riscos exercitados

> [LAB] Catálogo pequeno e versionado dos riscos que possuem controle executável neste laboratório. Não descreve riscos, processos ou arquitetura da TOTVS.

## Risco -> Controle -> Evidência -> Decisão

| Risk ID | Risco exercitado | Control ID | Controle executável | Evidência esperada | Decisão determinística |
|---|---|---|---|---|---|
| `RISK-API-001` | [LAB] Mudança quebra compatibilidade do contrato ou respostas deixam de obedecer aos schemas. | `CTRL-CONTRACT-001` | Validar OpenAPI 3.1, referências e schemas das respostas centrais. | Validador OpenAPI e assertions Ajv aprovados. | Falha bloqueia o gate. |
| `RISK-API-002` | [LAB] Requisição inválida inicia provisionamento ou retorna diagnóstico insuficiente. | `CTRL-REQUEST-001` | Enviar payload incompleto e exigir `400 INVALID_REQUEST` com campos inválidos. | Status, Error e detalhes dos campos. | Falha bloqueia o gate. |
| `RISK-API-003` | [LAB] Recurso inexistente é confundido com sucesso ou indisponibilidade. | `CTRL-NOTFOUND-001` | Consultar ID ausente e exigir `404` com Error consistente. | Status, código e IDs de diagnóstico. | Falha bloqueia o gate. |
| `RISK-API-004` | [LAB] Tentativas perdem correlação ou compartilham request IDs. | `CTRL-CORRELATION-001` | Ecoar correlation ID por tentativa e gerar request ID único. | Headers e Error correlacionáveis. | Falha bloqueia o gate. |
| `RISK-API-005` | [LAB] Retry legítimo retorna identidade incompatível ou conflito incorreto. | `CTRL-IDEMPOTENCY-001` | Repetir chave/payload antes e depois da conclusão e comparar identidade/estado. | Mesmos operation/resource IDs; replay explícito; estado monotônico. | Falha bloqueia o gate. |
| `RISK-API-006` | [LAB] Requisições concorrentes provisionam mais de uma instância ou operação. | `CTRL-DUPLICATE-001` | Disparar tentativas concorrentes com a mesma chave e comparar cardinalidade dos IDs. | Uma resposta original, demais replays e um único par de IDs. | Falha bloqueia o gate. |
| `RISK-API-007` | [LAB] Operação assíncrona conclui sem recurso consistente ou retry observa outro resultado. | `CTRL-ASYNC-001` | Fazer polling até `SUCCEEDED`, repetir a criação e consultar a instância `RUNNING`. | Estado final e identidade preservados sem sleep fixo. | Falha bloqueia o gate. |

## Metadados para a QE Intelligence Layer

- [LAB] Os testes publicam annotations Playwright `risk_id`, `risk`, `control_id` e `control`.
- [LAB] O relatório da execução fornece status e duração como evidência; a decisão permanece no gate determinístico.
- [LAB] Esses campos podem ser serializados futuramente sem chamar LLM e sem criar uma matriz paralela de cobertura.
- [LAB] Risco novo só entra neste mapa quando houver controle executável que produza evidência observável.
