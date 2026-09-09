# LAB-11 — Historical Quality Trends

> **Contexto:** [LAB] Documento técnico do laboratório pessoal, público e não oficial de Quality Engineering aplicado a Cloud (`totvs-cloud-qe-lab`). Não representa arquitetura, processos, dados, ferramentas, métricas ou SLAs internos da TOTVS.

---

## 1. Princípio Fundamental

**Risco -> Controle -> Evidência -> Decisão humana.**

Nenhum Quality Gate automatizado deve basear sua aprovação em projeções probabilísticas ou heurísticas de IA. Toda evolução de qualidade precisa ser comprovada por evidências determinísticas serializadas, rastreáveis e comparáveis ao longo do tempo.

O LAB-11 introduz a camada de **Histórico e Tendências Determinísticas de Qualidade**, permitindo responder objetivamente:
- A qualidade geral está melhorando, estável ou degradando?
- Quais dimensões técnicas mudaram entre execuções?
- A cobertura de riscos conhecidos e os gaps estão aumentando ou diminuindo?
- A performance está regredindo em relação aos checkpoints históricos?
- A postura de segurança está evoluindo de forma sustentável?
- As jornadas críticas e os cenários de resiliência distribuída permanecem estáveis?

---

## 2. Separação Conceitual: Comparação Pontual vs. Tendência Histórica

Uma das falhas comuns em automação de qualidade é rotular comparações pontuais (A/B) como "tendência". O laboratório estabelece uma distinção formal e inviolável:

### 2.1. Snapshot de Qualidade (`HistorySnapshot`)
Um registro determinístico, leve e versionável do estado consolidado de qualidade em um instante específico do repositório, associado a um `commitSha` e um `timestamp`. Não copia evidências brutas (traces OTel, payloads HTTP ou relatórios completos de scanners), armazenando apenas sinais normalizados essenciais.

### 2.2. Baseline de Referência
Um ponto de referência estável contra o qual execuções atuais são diretamente confrontadas (por exemplo, `evidence/performance/baseline.json`).

### 2.3. Comparação Pontual (`comparisonStatus`)
Avaliação determinística entre **duas execuções discretas**:
- Atual vs. Baseline (`IMPROVED`, `STABLE`, `REGRESSED`, `NO_BASELINE`).
- Checkpoint Atual ($S_{n}$) vs. Checkpoint Anterior ($S_{n-1}$) (`IMPROVED`, `STABLE`, `REGRESSED`, `NO_PREVIOUS_CHECKPOINT`).

A comparação pontual responde "esta execução foi melhor ou pior do que a anterior?", mas **não** indica direção consistente ou comportamento sustentado.

### 2.4. Tendência Histórica (`historicalTrend`)
Análise da direção de qualidade calculada sobre uma **série cronológica de múltiplos checkpoints**:
- Suporta: `IMPROVING`, `STABLE`, `DEGRADING`, `UNKNOWN`.
- **Regra de suficiência amostral**: São necessários **no mínimo 3 checkpoints comparáveis** ($n \ge 3$) para calcular qualquer tendência histórica.
- Com $n < 3$, a tendência de todas as dimensões e o status geral são estritamente classificados como `UNKNOWN` e a evidência visual exibe `Histórico insuficiente`.

---

## 3. Modelo de Snapshot Histórico

Armazenado em `evidence/history/snapshots/snapshot-<timestamp>-<sha>.json`, cada checkpoint segue o schema Zod estrito em `tools/history/history-schema.ts`:

```json
{
  "timestamp": "2026-09-09T19:45:00.000Z",
  "commitSha": "343843e51f8a",
  "overallStatus": "YELLOW",
  "riskCoverage": {
    "knownRisks": 31,
    "exercisedRisks": 24,
    "coveragePct": 77.4
  },
  "controlsPassed": 24,
  "controlsFailed": 0,
  "journeysPassed": 4,
  "journeysFailed": 0,
  "slaMet": 4,
  "slaBreached": 0,
  "resiliencePassed": 6,
  "resilienceFailed": 0,
  "recoveryDuration": {
    "minMs": 36,
    "avgMs": 42,
    "maxMs": 49
  },
  "observabilityStatus": "GREEN",
  "performanceStatus": "GREEN",
  "apiP95": 146,
  "apiP99": 285,
  "regressionStatus": "GREEN",
  "securityStatus": "YELLOW",
  "securityFindings": {
    "critical": 0,
    "high": 0,
    "medium": 1,
    "low": 0,
    "info": 0
  },
  "knownGaps": [
    "7 riscos conhecidos não possuem evidência serializada nesta coleta.",
    "Segurança: SECURITY_GAP_IAM_NOT_IMPLEMENTED."
  ]
}
```

---

## 4. Regras e Fórmulas Determinísticas de Tendência

O laboratório **não utiliza score ponderado arbitrário de 0 a 100**. As tendências são calculadas dimensão a dimensão a partir de sinais observáveis sobre a série ordenada $S_0, S_1, \dots, S_{k-1}$ ($k \ge 3$):

| Dimensão | Sinais Analisados | Fórmulas e Tolerâncias | Classificação |
|---|---|---|---|
| **RISK_COVERAGE** | `coveragePct` | $\Delta_{total} = S_{last}.pct - S_{first}.pct$<br>$\Delta_{recente} = S_{last}.pct - S_{prev}.pct$ | $\Delta_{recente} < -1.0 \lor \Delta_{total} < -1.0 \implies$ `DEGRADING`<br>$\Delta_{total} > 1.0 \land \Delta_{recente} \ge 0 \implies$ `IMPROVING`<br>Caso contrário $\implies$ `STABLE` |
| **CONTROLS** | `controlsPassed`, `controlsFailed` | Falhas recentes vs. eliminação de falhas | $S_{last}.failed > 0 \lor S_{last}.failed > S_{prev}.failed \implies$ `DEGRADING`<br>$S_{first}.failed > 0 \land S_{last}.failed = 0 \implies$ `IMPROVING`<br>$S_{last}.passed > S_{first}.passed \land S_{last}.failed = 0 \implies$ `IMPROVING`<br>Caso contrário $\implies$ `STABLE` |
| **CRITICAL_JOURNEYS** | `journeysFailed`, `slaBreached` | Ocorrência de quebra de jornada ou violação de SLA | $S_{last}.failed > 0 \lor S_{last}.breached > 0 \implies$ `DEGRADING`<br>$(S_{first}.failed > 0 \lor S_{first}.breached > 0) \land S_{last}.failed = 0 \land S_{last}.breached = 0 \implies$ `IMPROVING`<br>Caso contrário $\implies$ `STABLE` |
| **RESILIENCE** | `resilienceFailed`, `recoveryDuration.avgMs` | Falha no fluxo ou variação percentual na recuperação: $\Delta = \frac{S_{last}.avg - S_{first}.avg}{S_{first}.avg}$ (Tolerância: 15%) | $S_{last}.failed > 0 \lor \Delta > +0.15 \implies$ `DEGRADING`<br>$S_{first}.failed > 0 \land S_{last}.failed = 0 \implies$ `IMPROVING`<br>$\Delta < -0.15 \implies$ `IMPROVING`<br>Caso contrário $\implies$ `STABLE` |
| **OBSERVABILITY** | `observabilityStatus` | Transições de status de rastreabilidade | $S_{last} = \text{RED} \lor (\text{GREEN} \to \text{YELLOW}) \implies$ `DEGRADING`<br>$\text{RED} \to \text{GREEN/YELLOW} \lor \text{YELLOW} \to \text{GREEN} \implies$ `IMPROVING`<br>Caso contrário $\implies$ `STABLE` |
| **PERFORMANCE** | `performanceStatus`, `apiP95`, `apiP99` | Variação percentual de latência p95: $\Delta = \frac{S_{last}.p95 - S_{first}.p95}{S_{first}.p95}$ (Tolerância: 10%) | $S_{last} = \text{RED} \lor \Delta > +0.10 \implies$ `DEGRADING`<br>$\Delta < -0.10 \implies$ `IMPROVING`<br>Caso contrário $\implies$ `STABLE` |
| **REGRESSION** | `regressionStatus` | Status de regressão contra baseline | $S_{last} = \text{RED} \implies$ `DEGRADING`<br>$S_{first} = \text{RED} \land S_{last} = \text{GREEN} \implies$ `IMPROVING`<br>$S_{last} = \text{UNKNOWN} \implies$ `UNKNOWN`<br>Caso contrário $\implies$ `STABLE` |
| **SECURITY** | `critical`, `high`, `totalFindings` | Surgimento de vulnerabilidades críticas ou variação de total | $S_{last}.crit > 0 \lor S_{last}.high > 0 \lor \Delta_{crit/high} > 0 \implies$ `DEGRADING`<br>$S_{last}.total < S_{first}.total \implies$ `IMPROVING`<br>$S_{last}.total > S_{first}.total \implies$ `DEGRADING`<br>Caso contrário $\implies$ `STABLE` |
| **KNOWN_GAPS** | `knownGaps.length` | $\Delta_{gaps} = S_{last}.gaps - S_{first}.gaps$ | $\Delta_{gaps} < 0 \implies$ `IMPROVING`<br>$\Delta_{gaps} > 0 \implies$ `DEGRADING`<br>Caso contrário $\implies$ `STABLE` |
| **OVERALL_QUALITY** | Síntese de dimensões | Presença de degradação crítica vs. progresso geral | Se qualquer dimensão crítica (`CONTROLS`, `JOURNEYS`, `PERFORMANCE`, `SECURITY`) for `DEGRADING` ou $S_{last} = \text{RED} \implies$ `DEGRADING`<br>Se $\text{count}(\text{IMPROVING}) > \text{count}(\text{DEGRADING})$ sem degradação crítica $\implies$ `IMPROVING`<br>Caso contrário $\implies$ `STABLE` |

---

## 5. Integração com o Executive Quality Scorecard

O histórico determinístico integra-se ao scorecard (`tools/scorecard/`):
1. **Separação de canais**: A comparação pontual (ex: baseline vs. atual) é mantida sob `comparisonStatus`. O campo `trend` em cada dimensão e no scorecard geral reflete **exclusivamente** a série histórica determinística.
2. **Metadados históricos**: O JSON do scorecard inclui o bloco opcional `history`:
   ```json
   "history": {
     "checkpointsAnalyzed": 3,
     "canCalculateTrend": true,
     "comparisonStatus": "STABLE",
     "previousCommit": null,
     "overallHistoricalTrend": "IMPROVING"
   }
   ```
3. **Evidência visual**:
   - Se $n \ge 3$: exibe a tendência consolidada (`Em melhoria`, `Estável`, `Em degradação`) acompanhada de um mini-sparkline SVG de até 36px nos cards HTML e a indicação `(N checkpoints)` no Markdown e PDF.
   - Se $n < 3$: exibe `Histórico insuficiente` em todas as dimensões e no cabeçalho executivo, deixando explícito aos tomadores de decisão que não há dados históricos consolidados.
   - Nenhuma linha ou gráfico inventa pontos para preencher espaço.

---

## 6. Persistência e Comandos Operacionais

Os snapshots são pequenos (< 2 KB cada) e versionáveis via Git. **O CI não realiza auto-commits** para manter rastreabilidade e evitar conflitos em branch compartilhada.

### Comandos:
- **`npm run history:snapshot`**: Registra um novo checkpoint em `evidence/history/snapshots/` baseado nas evidências da execução atual.
- **`npm run history:build`**: Lê todos os snapshots versionados, valida schemas Zod, calcula as tendências determinísticas e consolida:
  - `evidence/history/history.json`
  - `evidence/history/trends.json`

---

## 7. Limites Estatísticos do Laboratório

[LAB] Limitações deliberadas do laboratório:
1. Não há projeção preditiva probabilística, regressão linear avançada ou modelos autoregressivos (ARIMA).
2. Não há banco de dados temporal (time-series database) como InfluxDB ou Prometheus. A persistência é inteiramente determinística baseada em arquivos JSON versionados.
3. Não há ferramentas analíticas pesadas (Grafana, Tableau). O scorecard HTML e PDF incorporam a síntese visual necessária.
4. A amostragem é baseada em execuções deliberadas no laboratório sob infraestrutura sintética controlada. Variações ambientais não monitoradas exigem validação humana.
