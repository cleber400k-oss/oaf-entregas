# Etapa 13 — Publicação efetiva

## Estado

O código está pronto para uma publicação real em HTTPS. A publicação externa exige uma conta/projeto de hospedagem conectado e, para domínio próprio, acesso ao DNS do domínio.

## Caminhos suportados

### Railway — recomendado para esta base

Use `deploy/railway/RAILWAY_DEPLOY.md`. O projeto mantém um único serviço Node.js e um Volume persistente para SQLite. O HTTPS é terminado pela plataforma, portanto não se usa o container Caddy da configuração de VPS.

### VPS próprio

A configuração da Etapa 12 continua válida: Docker Compose + Caddy ou Node/systemd + Caddy. Nesse caminho é necessário IP público do VPS e acesso ao DNS do domínio.

## Critério para considerar a Etapa 13 100% encerrada

1. Aplicação publicada em URL HTTPS real.
2. `/api/health` e `/api/ready` retornando 200.
3. Armazenamento persistente confirmado.
4. Administrador Principal criado.
5. `OAF_SETUP_CODE` removido depois do setup.
6. Admin, Comerciante e Entregador testados em aparelhos/redes diferentes.
7. Pedido criado pelo Comerciante aparecendo no Admin e no Entregador correto.
8. Fluxo completo concluído e refletido no Comerciante.
9. PWA instalada em pelo menos Android e, quando houver iPhone disponível, validada via Adicionar à Tela de Início.
10. Backup produzido e recuperação testada.

## Bloqueio externo atual

Sem uma hospedagem conectada não existe destino real onde enviar o servidor. Sem acesso ao DNS não é possível apontar um domínio próprio. Esses dois itens não podem ser simulados nem inventados.
