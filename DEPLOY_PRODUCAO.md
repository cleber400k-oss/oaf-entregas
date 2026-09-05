# OAF Entregas v1.3.0 — Deploy de produção

> **Etapa 13:** para Railway, use primeiro `deploy/railway/RAILWAY_DEPLOY.md`. Para VPS próprio, siga este documento.


## Opção recomendada: VPS Linux + Docker + Caddy

O Caddy cuida automaticamente do certificado TLS/HTTPS. O backend continua ouvindo apenas dentro da rede Docker.

### 1. DNS
Crie um registro **A** no seu domínio, por exemplo:

`entregas.seudominio.com.br -> IP_PÚBLICO_DO_SERVIDOR`

Aguarde o DNS responder para o IP correto antes de subir o Caddy.

### 2. Preparar arquivos
No servidor, copie este projeto e execute:

```bash
cp .env.production.example .env.production
cp .env.docker.example .env
mkdir -p data logs/caddy backups
```

Edite `.env.production`:
- `OAF_PUBLIC_URL=https://seu-dominio`
- `OAF_SETUP_CODE=` com um código novo de 6 dígitos
- mantenha `OAF_TRUST_PROXY=1`
- mantenha `OAF_COOKIE_SECURE=1`

Edite `.env` e coloque o domínio em `OAF_DOMAIN`.

### 3. Firewall
Libere somente:
- TCP 22 para administração SSH, de preferência restrito ao seu IP;
- TCP 80;
- TCP/UDP 443.

**Não publique a porta 8787 diretamente na internet.**

### 4. Subir

```bash
docker compose up -d --build
```

Conferir:

```bash
docker compose ps
docker compose logs -f app
docker compose logs -f caddy
```

Depois abra `https://seu-dominio` no celular.

### 5. Primeiro acesso
Use o código `OAF_SETUP_CODE` somente para criar o Administrador Principal. Depois de configurar o sistema, guarde/remova esse segredo do local onde terceiros possam vê-lo.

### 6. Backup

```bash
docker compose exec app node scripts/backup.js
```

Os backups ficam em `./backups`.

### 7. Atualização
Antes de trocar de versão:

```bash
docker compose exec app node scripts/backup.js
docker compose down
# substitua os arquivos da aplicação
docker compose up -d --build
```

Nunca apague a pasta `data` durante atualização.

## Opção alternativa: Node + systemd + Caddy instalado no VPS
Arquivos prontos estão em `deploy/systemd/` e `deploy/caddy/Caddyfile.vps.example`.

- aplicação: `/opt/oaf-entregas`
- banco: `/var/lib/oaf-entregas`
- logs: `/var/log/oaf-entregas`
- backups: `/var/backups/oaf-entregas`
- variáveis: `/etc/oaf-entregas.env`

Crie um usuário de sistema `oaf`, dê acesso apenas às pastas acima e habilite os serviços:

```bash
sudo systemctl enable --now oaf-entregas
sudo systemctl enable --now oaf-entregas-backup.timer
```
