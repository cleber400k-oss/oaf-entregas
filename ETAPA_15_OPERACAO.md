# OAF Entregas — Etapa 15

## Proteções aplicadas no Railway

- Volume `oaf-data` com backups DAILY e WEEKLY.
- `healthcheckPath`: `/api/ready`.
- `restartPolicy`: ON_FAILURE, até 10 tentativas.
- Aplicação sem sleep.
- Pre-deploy gate:
  - `node scripts/validate-package.js`
  - `node --check server.js`
  - `node --check scripts/backup.js`
  - `node --check scripts/restore.js`
  - `node --check scripts/remote-smoke.js`

Um deploy que falhar nesses comandos não deve chegar à aplicação ativa.

## Backup e restauração

O Railway está configurado com snapshots DAILY e WEEKLY do Volume. A restauração deve ser feita pela aba **Backups** do serviço, selecionando o snapshot desejado e revisando a alteração staged antes de aplicar.

Nunca apague ou recrie `oaf-data` durante uma restauração normal. Wipe de Volume também remove os backups associados.

## CI do GitHub

Copie `.github/workflows/ci.yml`, `package-lock.json` e `scripts/smoke-test.js` deste patch para a raiz do repositório.

A CI executa em push/PR para `main` e valida o pacote, sintaxe JavaScript e um smoke test local. Em execução manual (`workflow_dispatch`), também executa o smoke test contra a produção HTTPS.
