# TOTVS Cloud QE Lab

> [LAB] Laboratório pessoal, público e **não oficial**. Não representa a arquitetura, os processos, os controles, os dados ou as decisões da TOTVS.

[LAB] Este repositório exercita Quality Engineering aplicado a um control plane de nuvem fictício e pequeno. O fio condutor é:

```text
Risco -> Controle -> Evidência -> Decisão
```

[LAB] A maturidade de referência vem dos princípios do repositório público [`quality-engineering-lab`](https://github.com/carlosesmoreira07/quality-engineering-lab), adaptados a este domínio sem copiar sua solução ou presumir conhecimento interno.

## Classificação obrigatória

| Marcador | Uso |
|---|---|
| `[PUB]` | Informação pública confirmada em fonte citada |
| `[VAGA]` | Informação explicitamente publicada no escopo da vaga |
| `[LAB]` | Decisão criada exclusivamente para este laboratório |
| `[VALIDAR]` | Hipótese que só poderá ser confirmada após o onboarding |

## Entrega atual

- [LAB] **LAB-01:** charter, mapa público do produto e registro de hipóteses.
- [LAB] **LAB-02:** OpenAPI 3.1 e mock executável de um Cloud Control Plane fictício.
- [LAB] **LAB-03:** controles Playwright de API e contrato focados nos riscos do MVP.
- [LAB] **LAB-04:** semântica explícita e controles de idempotência, retry e concorrência no provisionamento assíncrono.
- [LAB] **IA assistiva:** coletor determinístico de contexto de mudança e arquitetura para futura análise por modelo; sempre consultiva.

[LAB] LAB-05 e posteriores — resiliência distribuída, segurança, performance, mensageria, evidências executivas e descoberta de onboarding — permanecem fora desta entrega.

## Estrutura

```text
apps/control-plane-mock/       mock local e estado em memória
docs/                          charter, mapa público, hipóteses e IA assistiva
specs/openapi/                 contrato versionado do laboratório
tests/api/                     controles comportamentais Playwright
tests/contract/                validação OpenAPI e schemas de resposta
tools/                         validação e contexto consultivo de impacto
.github/workflows/             gate mínimo, objetivo e determinístico
```

## Execução mínima

[LAB] Pré-requisitos: Node.js 22 ou superior e npm. Os testes usam somente o cliente HTTP do Playwright; não é necessário instalar navegador.

```bash
npm ci
npm run verify
```

[LAB] Para executar o mock manualmente:

```bash
npm run dev
curl http://127.0.0.1:4010/health
```

[LAB] Para gerar o contexto consultivo de uma mudança local:

```bash
npm run impact:context
```

[LAB] O relatório HTML do Playwright fica em `playwright-report/` e não é versionado. O mock pode ser apontado para outra porta com `PORT`; os testes podem usar outro endpoint com `BASE_URL`.

## Comece por aqui

- [Wiki do projeto](https://github.com/carlosesmoreira07/totvs-cloud-qe-lab/wiki)
- [Charter](docs/00-charter.md)
- [Mapa público do produto](docs/01-public-product-map.md)
- [Assumption Register](docs/02-assumptions.md)
- [Mapa de riscos exercitados](docs/04-quality-risk-map.md)
- [Arquitetura de IA assistiva](docs/ai-assisted-impact-analysis.md)
- [OpenAPI](specs/openapi/cloud-control-plane.yaml)
