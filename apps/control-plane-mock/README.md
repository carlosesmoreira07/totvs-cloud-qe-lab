# Cloud Control Plane Mock

[LAB] Mock local, em memória e não oficial. O contrato está em [`../../specs/openapi/cloud-control-plane.yaml`](../../specs/openapi/cloud-control-plane.yaml).

[LAB] O processo começa vazio a cada inicialização. Uma criação aceita retorna `202` e uma `Operation`; após um pequeno intervalo, a operação passa a `SUCCEEDED` e a instância a `RUNNING`.

```bash
npm run dev
```

