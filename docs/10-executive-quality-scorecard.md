# AI-05 — Regression & Executive Quality Scorecard

> [LAB] Implementação pessoal, pública e não oficial. Não representa scorecard, dashboard, SLA, arquitetura, processo ou decisão da TOTVS.

## Propósito

[LAB] O AI-05 transforma as evidências já produzidas pelo laboratório em uma leitura executiva rastreável, sem delegar decisão à IA:

```text
Evidências -> Normalização -> Regras determinísticas -> Scorecard -> HTML/PDF
                                                                      |
                                                                      v
                                                          LLM advisory opcional
                                                                      |
                                                                      v
                                                               Decisão humana
```

O JSON validado é a fonte de verdade do HTML, do PDF e da interpretação consultiva. O modelo não recalcula métricas, não muda status e não funciona como Quality Gate.

Os artefatos Markdown, HTML e PDF apresentam essa mesma fonte em PT-BR executivo. A primeira página responde imediatamente à situação geral, tendência, pontos de atenção, pontos sob controle, lacunas e prioridade recomendada; detalhes técnicos permanecem em áreas secundárias.

## Fontes consumidas

| Fonte | Sinal normalizado |
|---|---|
| `docs/04-quality-risk-map.md` | riscos e controles conhecidos |
| `evidence/resiliency/*.json` | resultado dos cenários e tempos de recuperação |
| `evidence/observability/*.json` | controles, traces, spans com erro e cadeias parciais |
| `evidence/journeys/*.json` | resultado E2E, SLA sintético e latências |
| `evidence/performance/current.json` | p50/p95/p99, throughput, taxa de erro, duplicidades e thresholds |
| `evidence/performance/baseline.json` | referência para a comparação pontual de regressão |

Ausência ou arquivo inválido é registrado como `UNKNOWN` ou gap; nunca como aprovação implícita.

## Dimensões e indicadores

O schema exige exatamente nove dimensões: Overall Quality, Risk Coverage, Controls, Critical Journeys, Resilience, Observability, Performance, Regression e Known Gaps. Cada dimensão contém `status`, `trend`, referências de evidência, indicadores, explicação e riscos relacionados.

Os indicadores centrais são:

- riscos conhecidos, exercitados e percentual de cobertura;
- controles aprovados, falhos e sem evidência na coleta;
- jornadas aprovadas/falhas e SLAs sintéticos atendidos/violados;
- recovery mínimo, médio e máximo;
- traces analisados, traces com `ERROR` e cenários com cadeia parcial;
- p50, p95, p99, throughput, taxa de erro, E2E p95 e duplicidades;
- comparação contra baseline, tolerância e métricas regredidas;
- gaps de cobertura, fontes ausentes e evidências inválidas.

## Regras determinísticas

| Status | Regra [LAB] |
|---|---|
| `GREEN` | evidência disponível, controle executado e critério atendido; Risk Coverage requer pelo menos 80% |
| `YELLOW` | sem falha determinística, mas há cobertura entre 50% e 79,9%, controle sem evidência, cadeia parcial de spans ou gap conhecido |
| `RED` | controle/jornada falhou, SLA sintético foi violado, threshold foi rompido, baseline regrediu ou Risk Coverage ficou abaixo de 50% |
| `UNKNOWN` | evidência necessária está ausente ou não é válida para calcular a dimensão |

O Overall Quality usa o pior status das dimensões. Quando todas as dimensões operacionais estão sem evidência, preserva `UNKNOWN`; quando existe sinal operacional, qualquer `RED` prevalece, seguido de `YELLOW`/`UNKNOWN` e então `GREEN`.

Spans `ERROR` de falhas simuladas não reprovam isoladamente: o resultado do controle continua sendo a evidência de decisão. Cadeias parciais permanecem `YELLOW` para interpretação humana.

## Tendência

| Sinal da comparação | Tendência |
|---|---|
| `IMPROVED` | `IMPROVING` |
| `STABLE` | `STABLE` |
| `REGRESSED` | `DEGRADING` |
| baseline ausente | `UNKNOWN` |

[LAB] `baseline.json` + `current.json` é apenas uma comparação pontual. Sem uma série de execuções comparáveis, o scorecard não declara tendência histórica.

## Artefatos e execução

```bash
npm run scorecard
npm run ai:scorecard
```

O primeiro comando produz:

- `evidence/scorecard/current.json`;
- `evidence/scorecard/executive-summary.md`;
- `evidence/scorecard/executive-scorecard.html`;
- `evidence/scorecard/executive-scorecard.pdf`.

O PDF é gerado localmente e em CI, sem SaaS externo. Markdown, HTML e PDF usam o rodapé `TOTVS Cloud QE Lab — Personal & Non-Official [LAB]` e `Generated from deterministic Quality Engineering evidence`. A decisão humana obrigatória permanece explícita na seção de governança.

## IA consultiva

`tools/ai/executive-scorecard-intelligence.ts` usa a interface `AiProvider`, o adapter OpenAI e Structured Outputs com Zod. A entrada contém apenas o scorecard determinístico; não inclui repositório, logs completos ou secrets. A apresentação final foi refinada para PT-BR executivo, mantendo a estrutura, a classificação e a governança originais.

Cada finding é classificado como:

- `OBSERVED`: presente diretamente no scorecard;
- `INFERRED`: hipótese sustentada por sinais do scorecard;
- `GAP`: evidência ausente ou insuficiente.

Sem `OPENAI_API_KEY`, com timeout, falha do provider, JSON inválido ou linguagem decisória proibida, a saída é `AI_EXECUTIVE_SCORECARD_UNAVAILABLE`. O job usa `continue-on-error: true` e não bloqueia o gate determinístico.

São proibidas conclusões como “aprovado pela IA”, “reprovado pela IA”, “seguro para produção”, “pronto para release” e “incidente evitado”.

## Linguagem visual e referências públicas

[PUB] As páginas oficiais da TOTVS Cloud descrevem gestão centralizada, monitoramento, disponibilidade e administração de recursos via T-Cloud. Esses conceitos orientaram a hierarquia de informações e os cartões de status: [TOTVS Cloud](https://www.totvs.com/cloud/), [TOTVS Cloud IaaS](https://produtos.totvs.com/ficha-tecnica/totvs-cloud-iaas/) e [TOTVS Cloud PaaS](https://www.totvs.com/cloud/paas/).

[LAB] A paleta combina azul cloud, azul escuro, ciano de apoio, neutros claros e cores semânticas de status. Tipografia do sistema, cartões, badges, sombras leves e composição são aproximações próprias do laboratório inspiradas apenas no universo visual público de tecnologia/cloud. Nenhum logotipo, fonte, ilustração ou ativo proprietário foi copiado, e o visual não deve ser interpretado como identidade oficial TOTVS/T-Cloud.

## Limites conscientes

- [LAB] SLAs são sintéticos e não representam SLA real da TOTVS.
- [LAB] Não há série histórica, análise estatística longitudinal nem janela móvel.
- [LAB] Não há segurança automatizada, SAST/DAST, Kubernetes, Grafana corporativo ou auto-remediação.
- [LAB] Não há RAG, embeddings, vector database ou persistência das respostas do modelo.
- [VALIDAR] Critérios executivos, tolerâncias e cadência reais só podem ser discutidos após contexto autorizado de onboarding.
