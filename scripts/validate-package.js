'use strict';
const fs=require('node:fs');const path=require('node:path');const root=path.resolve(__dirname,'..');
const required=['server.js','package.json','public/index.html','public/manifest.webmanifest','public/sw.js','public/app-icon-192.png','public/app-icon-512.png','deploy/caddy/Caddyfile','Dockerfile','docker-compose.yml','scripts/backup.js','scripts/restore.js'];
let fail=0;for(const f of required){const ok=fs.existsSync(path.join(root,f));console.log(`${ok?'PASS':'FAIL'}  ${f}`);if(!ok)fail++}
const manifest=JSON.parse(fs.readFileSync(path.join(root,'public/manifest.webmanifest'),'utf8'));if(manifest.start_url!=='/'){console.log('FAIL  manifest start_url');fail++}else console.log('PASS  manifest start_url');
process.exitCode=fail?1:0;
