# Homologação em celulares reais

Use pelo menos 3 aparelhos ou 3 sessões independentes:

- Celular A: Administrador
- Celular B: Comerciante
- Celular C: Entregador

## Cenário obrigatório
1. Todos acessam exatamente o mesmo endereço `https://...`.
2. Admin cria Comerciante e Entregador.
3. Entregador faz login e entra na fila.
4. Comerciante cria uma entrega.
5. Entregador recebe o popup bloqueante `Nova entrega disponível`.
6. Recarregue/feche/reabra o app do Entregador: o mesmo pedido deve continuar atribuído e o popup deve voltar.
7. Execute: Iniciar entrega → Cheguei ao comércio → coleta → em rota → destino → finalização.
8. Comerciante deve acompanhar cada mudança.
9. Admin deve enxergar fila/status em tempo real.
10. Ao concluir, o Entregador deve voltar ao fim da fila e o financeiro do Comerciante deve refletir a entrega.

## Testes de rede
- troque um celular do Wi‑Fi para 4G/5G;
- bloqueie a tela por alguns minutos e retorne;
- feche e abra o PWA;
- desligue temporariamente a internet: a interface deve bloquear gravações até reconectar;
- confirme que não surgiram pedidos duplicados.

## PWA
No Android/Chrome, use **Adicionar à tela inicial / Instalar app**. O endereço precisa estar em HTTPS. Depois de instalar, confira abertura standalone, ícone e retomada da sessão.
