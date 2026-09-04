# Mapa público de contexto

> [LAB] Este mapa delimita inspiração de domínio. Ele não descreve arquitetura interna nem afirma que o mock corresponde ao produto real.

## O que as fontes públicas permitem afirmar

| Classificação | Capacidade pública | Uso permitido no laboratório | Fonte |
|---|---|---|---|
| [PUB] | A TOTVS Cloud publica ofertas nas modalidades PaaS e IaaS. | Contextualizar o estudo de QE para cloud. | [TOTVS Cloud](https://www.totvs.com/cloud/) |
| [PUB] | O material público de IaaS descreve autosserviço e gerenciamento do ambiente via T-Cloud. | Inspirar genericamente a ideia de control plane; não sua API ou implementação. | [Ficha técnica IaaS](https://produtos.totvs.com/ficha-tecnica/totvs-cloud-iaas/) |
| [PUB] | O material público cita gerenciamento de VMs, ambientes, discos, redes, VPN e regras de acesso. | Escolher “instância” como único recurso fictício do MVP. Os demais recursos ficam fora do escopo. | [Ficha técnica IaaS](https://produtos.totvs.com/ficha-tecnica/totvs-cloud-iaas/) |
| [PUB] | A Central de Atendimento informa que a contratação do IaaS é realizada pelo cliente através do T-Cloud. | Reconhecer uma superfície pública de autosserviço, sem inferir seu fluxo técnico. | [Central de Atendimento TOTVS](https://centraldeatendimento.totvs.com/hc/pt-br/articles/15648400768407-CLOUD-TCLOUD-IAAS-Contratar-o-Servi%C3%A7o-IaaS-da-TOTVS-Cloud) |

## Fronteira do sistema fictício

```text
[LAB] Cliente de API
          |
          v
[LAB] Cloud Control Plane Mock
       |-- saúde
       |-- solicitação idempotente de instância
       |-- consulta de operação assíncrona
       `-- consulta de instância
```

- [LAB] O mock não usa endpoints, payloads, estados, nomes de recursos, regiões, flavors ou regras atribuídos à TOTVS.
- [LAB] O provisionamento é uma simulação local em memória e completa após um pequeno intervalo.
- [LAB] Não há data plane, hypervisor, conta real, cobrança, rede, storage, backup, autenticação ou integração externa.

## O que não pode ser inferido

- [VALIDAR] Arquitetura, protocolos, filas, bancos, provedores e padrões de consistência reais.
- [VALIDAR] Contratos de API, estados, códigos de erro, limites, SLAs, SLOs e políticas de retry reais.
- [VALIDAR] Estratégia de testes, processo de release, observabilidade, incidentes e responsabilidades dos times.
- [VALIDAR] Relação entre as capacidades publicadas e componentes internos específicos.

## Fontes e data de consulta

- [PUB] Fontes oficiais consultadas em 2026-09-03: [TOTVS Cloud](https://www.totvs.com/cloud/), [Ficha técnica TOTVS Cloud IaaS](https://produtos.totvs.com/ficha-tecnica/totvs-cloud-iaas/) e [Central de Atendimento TOTVS](https://centraldeatendimento.totvs.com/hc/pt-br/articles/15648400768407-CLOUD-TCLOUD-IAAS-Contratar-o-Servi%C3%A7o-IaaS-da-TOTVS-Cloud).

