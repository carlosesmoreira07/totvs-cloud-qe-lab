# LAB-10 — Security Quality Pack

> [LAB] Pacote pessoal, público e não oficial para exercitar segurança em Quality Engineering. Não representa arquitetura, controles, ferramentas, resultados ou postura de segurança da TOTVS.

## Propósito e recorte

[LAB] O LAB-10 adiciona controles pequenos e reproduzíveis para quatro superfícies do repositório: secrets, dependências, código estático e API local. A cadeia continua explícita:

```text
Risco -> Controle executável -> Evidência normalizada -> Regra determinística -> Decisão humana
```

[LAB] Nenhum scanner aponta para sistemas, domínios ou ambientes da TOTVS. O DAST é passivo e roda somente contra o mock local em `127.0.0.1` ou no alias local equivalente usado pelo container.

## Vulnerabilidade não é risco

- [LAB] Neste pack, “vulnerabilidade” é o sinal técnico de uma fraqueza potencial dentro do escopo que cada scanner consegue observar.
- [LAB] Risco combina o sinal técnico com contexto, exposição e impacto no laboratório. Um finding não substitui triagem humana, e ausência de finding não prova segurança.
- [LAB] O gate usa somente regras determinísticas: segredo real, finding aberto `HIGH`/`CRITICAL` ou falha de controle crítico bloqueiam; sinais `INFO`/`LOW` e o gap IAM permanecem consultivos.

## Security in Quality Engineering

[LAB] Segurança em QE significa transformar modos de falha relevantes em controles repetíveis, produzir evidência diagnosticável e levar exceções à decisão humana. Os scanners ampliam o feedback e a consistência da revisão; não substituem análise de ameaça, conhecimento de contexto, code review, pentest ou responsabilização profissional.

## Camadas implementadas

| Ferramenta | O que encontra neste LAB | O que não prova |
|---|---|---|
| TruffleHog 3.97.1 | padrões de credencial no working tree e histórico Git locais; o valor bruto é descartado | que nenhum segredo exista fora do repositório analisado |
| `npm audit` | advisories conhecidos para dependências resolvidas no `package-lock.json` | ausência de falhas próprias ou cobertura de todo o supply chain |
| Semgrep 1.172.0 | padrões locais de execução de comando/código, log sensível e SQL interpolado | correção semântica completa ou ausência de vulnerabilidade |
| OWASP ZAP 2.17.0 Baseline | sinais passivos observados no endpoint local, sem ataques ativos | exploração, autorização, segurança de produção ou cobertura de toda a API |
| Playwright | comportamento HTTP controlado para entrada, erros, headers e identificadores | pentest, IAM, abuso de negócio ou proteção de infraestrutura real |

[PUB] O ZAP Baseline executa spider e análise passiva, sem ataques ativos, e diferencia alertas de falhas: [OWASP ZAP Baseline Scan](https://www.zaproxy.org/docs/docker/baseline-scan/). [PUB] O `npm audit` consulta vulnerabilidades conhecidas das dependências e oferece saída JSON: [npm audit](https://docs.npmjs.com/cli/v11/commands/npm-audit). [PUB] TruffleHog documenta varredura de filesystem e saída JSON: [TruffleHog](https://docs.trufflesecurity.com/). [PUB] Semgrep CE permite análise local por regras configuráveis: [Semgrep CE](https://semgrep.dev/docs/getting-started/quickstart-ce).

## Segurança de API e OWASP API Security Top 10

[PUB] O OWASP API Security Top 10 mantém uma referência pública de riscos frequentes em APIs, incluindo Security Misconfiguration: [OWASP API Security Top 10 — 2023](https://owasp.org/API-Security/editions/2023/en/0x11-t10/).

[LAB] O pack usa essa referência apenas como lente. Ele exercita validação de entrada, respostas sem detalhes internos, limite de corpo, Content-Type, headers defensivos e identificação sem formato de credencial. Não declara conformidade OWASP e não cria autenticação fictícia.

## Evidência e normalização

`tools/security/` converte formatos distintos para um finding comum:

```json
{
  "source": "SAST",
  "ruleId": "qe-lab-dynamic-code-execution",
  "severity": "HIGH",
  "subject": "Execução dinâmica de código",
  "location": "apps/example.ts:10",
  "description": "Sinal normalizado sem trecho sensível",
  "remediation": "Remover a construção insegura",
  "status": "OPEN"
}
```

[LAB] `evidence/security/findings.json` agrega findings deduplicados. Os quatro arquivos de scanner e `summary.json` preservam execução, controles e gaps sem logs completos, requests, responses ou valores de segredo. O formato é serializável para uma evolução futura da QE Intelligence Layer, mas nenhuma LLM é chamada no LAB-10.

## Security Status e gate

| Status | Regra determinística [LAB] |
|---|---|
| `GREEN` | quatro scanners executados, nenhum `HIGH`/`CRITICAL` aberto, nenhum controle crítico falho e nenhum gap relevante |
| `YELLOW` | finding `MEDIUM`, aceitação explícita ou gap conhecido; o gap IAM mantém o estado atual amarelo |
| `RED` | segredo detectado, finding aberto `HIGH`/`CRITICAL` ou controle crítico falho |
| `UNKNOWN` | scanner essencial indisponível ou evidência insuficiente; nunca é convertido em sucesso |

[LAB] `security:scan` encerra com falha para `RED` e `UNKNOWN`. O scorecard apenas reproduz essa evidência na dimensão `SECURITY`; a decisão final continua humana.

### Resultado versionado deste checkpoint

- [LAB] `Security Status = YELLOW`.
- [LAB] Quatro scanners executados; zero findings `HIGH`/`CRITICAL` abertos e zero controles críticos falhos.
- [LAB] Um finding `MEDIUM` do ZAP, regra `10049` (`Non-Storable Content`), está `ACCEPTED_LAB`: o alerta é normalizado por regra/origem, e `Cache-Control: no-store` é deliberado para respostas operacionais.
- [LAB] `SECURITY_GAP_IAM_NOT_IMPLEMENTED` permanece aberto e impede status verde.

## Execução

```bash
npm run test:security
npm run security:scan
npm run scorecard
```

[LAB] Os scanners em container são fixados por versão. `npm audit` usa somente metadados de dependência do lockfile. Fixtures e relatórios gerados (`playwright-report`, `test-results`, `blob-report`) são excluídos do secret scan para evitar material sintético/empacotado; arquivos de projeto e histórico permanecem no escopo. Nenhum secret, raw scan contendo material sensível ou `.env` deve ser versionado.

## Limites conscientes

- `SECURITY_GAP_IAM_NOT_IMPLEMENTED`: o mock não implementa autenticação nem autorização; isso mantém `YELLOW`.
- [LAB] Não há pentest, DAST ativo, fuzzing, SCA de imagens, SBOM, assinatura de artefato, IaC scanning ou gestão de exceções por prazo.
- [LAB] O ZAP percorre somente a superfície alcançável a partir do endpoint local informado; ele não demonstra cobertura integral da OpenAPI.
- [LAB] Regras Semgrep são deliberadamente pequenas e não substituem rulepacks amplos revisados por especialistas.
- [VALIDAR] Ferramentas, severidades, políticas e critérios reais de segurança só podem ser conhecidos após onboarding autorizado.
