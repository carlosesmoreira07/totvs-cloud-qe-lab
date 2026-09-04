# Executive Quality Scorecard — AI-05

> [LAB] Síntese determinística e não oficial. A decisão permanece humana.

- Status geral: **YELLOW**
- Tendência pontual: **IMPROVING**
- Riscos exercitados: **22/34 (64.7%)**
- Controles: **22 aprovados / 0 falhos / 12 sem evidência nesta coleta**
- Jornadas: **4/4 aprovadas**
- SLAs sintéticos: **4/4 atendidos**

| Dimensão | Status | Tendência | Explicação |
|---|---|---|---|
| Overall Quality | YELLOW | IMPROVING | Pior status determinístico entre as dimensões; UNKNOWN é preservado quando não há evidência operacional suficiente. |
| Risk Coverage | YELLOW | UNKNOWN | Cobertura calculada por risco conhecido com ao menos um controle presente nas evidências serializadas desta coleta. |
| Controls | YELLOW | UNKNOWN | Consolidação deduplicada por controlId; ausência de arquivo não é convertida em aprovação. |
| Critical Journeys | GREEN | UNKNOWN | Resultado e SLA sintético são lidos das jornadas ponta a ponta; qualquer falha ou breach torna a dimensão vermelha. |
| Resilience | GREEN | UNKNOWN | Cenários [LAB] verificam recuperação e consistência nas falhas distribuídas efetivamente exercitadas. |
| Observability | YELLOW | UNKNOWN | Spans ERROR esperados em falhas simuladas não reprovam sozinhos; controles falhos reprovam e cadeias parciais pedem revisão. |
| Performance | GREEN | IMPROVING | Thresholds sintéticos: MET; error rate 0; E2E p95 297.7 ms. |
| Regression | GREEN | IMPROVING | Baseline versus current é uma comparação pontual determinística; não representa tendência histórica. |
| Known Gaps | YELLOW | UNKNOWN | Lacunas permanecem visíveis e nunca são interpretadas como sucesso implícito. |

## Gaps conhecidos

- 12 riscos conhecidos não possuem evidência serializada nesta coleta.
- 1 cenários de observabilidade possuem cadeia parcial de spans e exigem interpretação humana.
- Baseline e current permitem comparação pontual, mas ainda não formam série histórica.

> Comparação pontual entre baseline e execução atual; não constitui série histórica.

> SLAs sintéticos do laboratório não representam SLA real da TOTVS.

**Quality Engineering Lab — NÃO OFICIAL | Evidências do laboratório | Decisão humana obrigatória**
