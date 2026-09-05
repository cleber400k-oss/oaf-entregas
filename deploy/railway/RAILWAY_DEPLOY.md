# Publicação real no Railway — OAF Entregas v1.3.0

Este é o caminho recomendado para a primeira publicação real da Etapa 13.

## 1. Criar o serviço

Crie um projeto/serviço Railway usando esta pasta como código-fonte. O `Dockerfile` na raiz é detectado automaticamente.

## 2. Anexar armazenamento persistente — obrigatório

Anexe um **Volume** ao serviço e monte-o em:

`/app/data`

O servidor também reconhece `RAILWAY_VOLUME_MOUNT_PATH` automaticamente. A variável `OAF_REQUIRE_PERSISTENT_STORAGE=1` faz o backend recusar a inicialização em Railway se o Volume não estiver presente, evitando que o banco SQLite seja criado em armazenamento efêmero.

## 3. Variáveis

No painel de Variables, use os valores de `deploy/railway/variables.example`.

Não defina `PORT`: Railway injeta essa variável e o servidor já usa `process.env.PORT`.

Depois do primeiro cadastro do Administrador Principal, remova `OAF_SETUP_CODE` e faça um redeploy.

## 4. Healthcheck

Configure:

`/api/ready`

O endpoint valida o banco antes de responder como pronto.

## 5. Domínio HTTPS

Primeiro gere um domínio Railway para homologação. O servidor reconhece `RAILWAY_PUBLIC_DOMAIN` e monta a URL pública automaticamente.

Para domínio próprio, adicione o domínio no serviço e copie exatamente os registros DNS indicados pelo Railway. Para subdomínio, normalmente serão fornecidos CNAME e TXT de verificação. O certificado HTTPS é emitido pela plataforma após a verificação.

Exemplo recomendado:

`entregas.seudominio.com.br`

## 6. Primeiro acesso

Abra o endereço HTTPS. A primeira tela pedirá o código de configuração definido em `OAF_SETUP_CODE`. Crie o Administrador Principal e o WhatsApp de suporte.

## 7. Teste remoto

Na sua máquina, com Node.js 22.5+:

`node scripts/remote-smoke.js https://SEU-DOMINIO`

O teste verifica backend, headers HTTPS, PWA, Manifest, Service Worker e armazenamento persistente reportado pelo servidor.

## 8. Banco e backups

O banco fica no Volume. Com montagem `/app/data`:

- banco: `/app/data/oaf-entregas.sqlite`
- logs: `/app/data/logs/`
- backups locais do app: `/app/data/backups/`

Além desses backups, habilite também backup do Volume no provedor quando disponível.

## 9. Atualizações

Nunca remova/troque o Volume ao publicar uma nova versão. Um serviço com Volume pode ter uma pequena janela de indisponibilidade durante redeploy; isso é preferível a executar dois processos escrevendo no mesmo SQLite.

