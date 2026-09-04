# Cloud Control Plane Mock

[LAB] Mock local, em memória e não oficial. O contrato está em [`../../specs/openapi/cloud-control-plane.yaml`](../../specs/openapi/cloud-control-plane.yaml).

[LAB] O processo começa vazio a cada inicialização. Uma criação aceita retorna `202` e uma `Operation`; após um pequeno intervalo, a operação passa a `SUCCEEDED` e a instância a `RUNNING`.

## Semântica de idempotência

- [LAB] A primeira requisição válida para uma `Idempotency-Key` cria exatamente uma `Operation` e uma `Instance` e retorna `Idempotency-Replayed: false`.
- [LAB] Mesma chave e mesmo payload retornam `202`, `Idempotency-Replayed: true`, os mesmos IDs e o estado atual da operação, inclusive depois de concluída.
- [LAB] Mesma chave e payload diferente retornam `409 IDEMPOTENCY_CONFLICT`; a operação original permanece inalterada e nenhum novo recurso é criado.
- [LAB] Requisições concorrentes são serializadas na fronteira síncrona do store em memória: uma vence a criação e as demais observam o registro já criado.
- [LAB] Cada tentativa recebe um `X-Request-Id` único e ecoa seu `X-Correlation-Id`. O campo `Operation.correlationId` preserva a correlação da primeira tentativa aceita.
- [LAB] O escopo da chave é o processo atual. Reiniciar o mock apaga todos os registros; não há garantia distribuída ou persistente.

```bash
npm run dev
```
