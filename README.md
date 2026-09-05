# OAF Entregas v1.3.0 — Etapa 13

Release preparada para **produção HTTPS**.

## O que esta etapa adiciona
- configuração explícita de produção;
- suporte seguro a reverse proxy (`OAF_TRUST_PROXY`);
- cookies `Secure` em HTTPS;
- headers de segurança, CSP e HSTS;
- health-check `/api/health` e readiness `/api/ready`;
- logs estruturados em arquivo;
- filtragem de estado por perfil: Comerciante e Entregador não recebem a base administrativa completa;
- valores financeiros removidos também da resposta de rede entregue ao Entregador;
- desligamento gracioso com checkpoint SQLite;
- backup online consistente via `node:sqlite`;
- restauração com verificação de integridade e proteção contra servidor ativo;
- Dockerfile + Docker Compose;
- Caddy com TLS automático;
- arquivos systemd para VPS sem Docker;
- backup diário por timer systemd;
- PWA atualizado para v1.3.0;
- `robots.txt` para não indexar a aplicação;
- checklist de homologação em celulares reais.

## Requisito sem Docker
Node.js 22.5 ou superior.

## Desenvolvimento/rede local
```bash
node server.js
```

## Produção
Leia `DEPLOY_PRODUCAO.md`.

## Validação local
Com o servidor rodando:
```bash
node scripts/smoke-test.js http://127.0.0.1:8787
```

## Backup
```bash
node scripts/backup.js
```

## Restauração
Pare o servidor antes:
```bash
node scripts/restore.js backups/ARQUIVO.sqlite --yes
```

## Observação
Este pacote está pronto para publicação, mas nenhum domínio/VPS externo foi modificado nesta etapa porque credenciais de hospedagem e DNS não foram fornecidas.

## Publicação real — Etapa 13

O pacote inclui agora um caminho de deploy em Railway em `deploy/railway/RAILWAY_DEPLOY.md`, autodetecção do domínio público, autodetecção do Volume persistente e um teste remoto em `scripts/remote-smoke.js`. Para Railway, anexe um Volume antes da operação real e mantenha `OAF_REQUIRE_PERSISTENT_STORAGE=1`.
