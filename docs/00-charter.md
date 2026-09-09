# Charter do laboratório

## Propósito

- [LAB] Construir um laboratório pessoal e público para praticar Quality Engineering aplicado a Cloud antes do onboarding.
- [LAB] Demonstrar como riscos técnicos relevantes podem ser convertidos em controles executáveis, evidências legíveis e decisões determinísticas.
- [LAB] Usar um control plane fictício como sistema sob teste, sem reproduzir qualquer produto interno.

## Escopo atual

- [LAB] LAB-01 estabelece linguagem, limites, fontes e controle de hipóteses.
- [LAB] LAB-02 oferece um contrato OpenAPI e um mock local para provisionamento assíncrono de instâncias fictícias.
- [LAB] LAB-03 protege o contrato, validação, ausência de recursos, correlação e idempotência por meio de testes de API.
- [LAB] LAB-04 aprofunda retry, conflitos de chave, concorrência e prevenção de provisionamento duplicado, preservando estado em memória.
- [LAB] LAB-05 introduz persistência PostgreSQL, Transactional Outbox e NATS JetStream para estudar consistência transacional e mensageria distribuída.
- [LAB] LAB-06 adiciona um pacote de resiliência e recuperação distribuída (Distributed Failure & Recovery Pack) cobrindo falhas de broker, parada de consumer, redeliveries, crashes de publisher, timeouts de API e erros transacionais antes de ACK.
- [LAB] LAB-07 introduz observabilidade e telemetria distribuída com OpenTelemetry cobrindo os 6 spans do ciclo assíncrono, métricas QE de baixa cardinalidade, OpenTelemetry Collector e Jaeger local.
- [LAB] LAB-08 introduz jornadas sintéticas de ponta a ponta (Synthetic & End-to-End Control Plane Journeys), validando o fluxo integral do usuário sob SLAs didáticos [LAB] e gerando evidências estruturadas em JSON.
- [LAB] LAB-09 introduz verificação contínua de performance e carga com k6/autocannon, baseline versionado e asserções estritas de latência, throughput e error rate.
- [LAB] LAB-10 introduz o pacote de segurança Shift-Left (SAST, Secret Scan com TruffleHog/Gitleaks, Análise de Dependências e DAST com OWASP ZAP) e o Scorecard Executivo A4 Landscape de 3 páginas.
- [LAB] LAB-11 introduz o histórico determinístico de qualidade (Historical Quality Trends) e detecção de regressão entre múltiplos checkpoints sem uso de LLM.
- [LAB] LAB-12 consolida o laboratório no Pacote Executivo e Portfólio Final (Final Architecture, Capability Map, Executive Narrative, Onboarding Playbook, Demo Script e Final Quality Matrix).
- [LAB] AI-01 a AI-07 introduzem a QE Intelligence Layer consultiva (Impact Analysis, Failure Intelligence, Telemetry Intelligence, Architecture Change, Flaky & Stability, Security & Policy, e Trend & Regression Intelligence), com validação Zod estrita, fallbacks determinísticos e autoridade de release 100% humana.

## Não objetivos

- [LAB] Não representar, testar, integrar ou inferir sistemas reais da TOTVS.
- [LAB] Não propor arquitetura alvo, processo de entrega, SLA, modelo operacional ou Quality Gate da TOTVS.
- [LAB] Não criar uma plataforma de produção, framework genérico, dashboard, Jira ou ambiente cloud real.
- [LAB] Não implementar nesta etapa Kubernetes, clusters NATS multi-região, auto-remediation autônoma, RAG ou vector database.

## Princípios de QE

- [LAB] **Risco antes da ferramenta:** automatizar somente quando um modo de falha relevante estiver explícito.
- [LAB] **Controle proporcional:** usar a camada de teste mais barata que produza sinal suficiente.
- [LAB] **Evidência observável:** status, corpo, headers e relatório executado valem mais que intenção documentada.
- [LAB] **Decisão determinística:** gates usam resultados objetivos; análises probabilísticas são consultivas.
- [LAB] **Contrato e implementação juntos:** OpenAPI, mock e testes evoluem na mesma mudança.
- [LAB] **Hipóteses visíveis:** incertezas sobre contexto futuro ficam no Assumption Register até validação humana.
- [LAB] **Diagnóstico sobre volume:** uma suíte curta, isolada e explicativa é preferível a muitos testes redundantes.

## Limites éticos e de informação

- [LAB] O mapa público usa somente materiais publicados pela TOTVS e mantém links para as fontes.
- [LAB] Dados, nomes, regiões, imagens, flavors, IDs e tempos usados no mock são artificiais.
- [VALIDAR] Qualquer semelhança entre o laboratório e um fluxo real deve ser tratada como coincidência até validação autorizada após onboarding.
- [LAB] Informação interna eventualmente conhecida no futuro não deve ser copiada para este repositório público.

## Critério de sucesso desta etapa

- [LAB] Uma pessoa deve conseguir instalar dependências, validar a OpenAPI, iniciar o mock e executar os controles com `npm ci` e `npm run verify`.
- [LAB] Cada falha deve indicar o risco observado, o controle que falhou e a evidência técnica disponível.
- [LAB] Nenhuma conclusão de IA participa do resultado do Quality Gate.

---

## LAB SCOPE COMPLETE

> **Declaração Formal de Fechamento de Escopo [LAB]**  
>  
> Em conformidade com o planejamento estratégico do laboratório, o ciclo completo de engenharia de qualidade compreendendo **LAB-01 a LAB-12** e as automações consultivas de **AI-01 a AI-07** encontra-se formalmente **CONCLUÍDO E CONGELADO** (`LAB SCOPE COMPLETE`).
>  
> O repositório atingiu seu objetivo educacional e demonstrativo: estabelecer uma referência ponta a ponta de Quality Engineering para microsserviços Cloud, articulando a cadeia `Risco -> Controle -> Evidência -> Decisão Humana` com governança estrita, 175 testes automatizados, 0 flaky tests e 100% de reproducibilidade determinística.
>  
> Nenhuma extensão arquitetural adicional (como auto-remediation, RAG ou orquestração Kubernetes) será introduzida neste repositório experimental público, preservando a fidelidade da linha de base de evidências.

