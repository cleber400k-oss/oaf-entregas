#!/usr/bin/env node
'use strict';
const target = String(process.argv[2] || process.env.OAF_REMOTE_URL || '').replace(/\/$/,'');
if(!target){console.error('Uso: node scripts/remote-smoke.js https://seu-dominio');process.exit(2)}
if(!/^https:\/\//i.test(target)){console.error('O endereço de produção deve usar HTTPS.');process.exit(2)}
let fails=0, passes=0;
function ok(cond,msg,detail=''){if(cond){passes++;console.log('OK   '+msg+(detail?' — '+detail:''))}else{fails++;console.error('FAIL '+msg+(detail?' — '+detail:''))}}
async function get(path,opts={}){const r=await fetch(target+path,{redirect:'manual',...opts});return r}
(async()=>{
  try{
    const health=await get('/api/health');
    ok(health.status===200,'/api/health responde 200',String(health.status));
    const h=await health.json().catch(()=>({}));
    ok(h.ok===true,'backend saudável');
    ok(String(h.version||'').startsWith('1.3.'),'backend v1.3.x',String(h.version||''));
    ok(h.database==='ok','SQLite acessível',String(h.database||''));
    if(h.platform==='railway') ok(h.persistentStorage===true,'Volume persistente Railway detectado');

    const ready=await get('/api/ready');
    ok(ready.status===200,'/api/ready responde 200',String(ready.status));
    const rr=await ready.json().catch(()=>({}));
    ok(rr.database==='ok','readiness valida banco');

    const config=await get('/api/config');
    ok(config.status===200,'/api/config responde 200');
    const c=await config.json().catch(()=>({}));
    ok(c.production===true,'modo produção ativo');
    ok(c.secureContext===true,'proxy HTTPS reconhecido');
    ok(c.realtime==='sse','sincronização SSE ativa');

    const root=await get('/');
    ok(root.status===200,'frontend responde 200');
    const hsts=String(root.headers.get('strict-transport-security')||'');
    ok(/max-age=/i.test(hsts),'HSTS presente');
    ok(!!root.headers.get('content-security-policy'),'CSP presente');
    ok(String(root.headers.get('x-content-type-options')||'').toLowerCase()==='nosniff','X-Content-Type-Options presente');
    const html=await root.text();
    ok(/OAF Entregas/i.test(html),'marca OAF Entregas no frontend');

    const manifest=await get('/manifest.webmanifest');
    ok(manifest.status===200,'Manifest PWA acessível');
    const m=await manifest.json().catch(()=>({}));
    ok(/OAF Entregas/i.test(String(m.name||'')),'Manifest com nome correto');
    ok(Array.isArray(m.icons)&&m.icons.length>=2,'Manifest possui ícones');

    const sw=await get('/sw.js');
    ok(sw.status===200,'Service Worker acessível');
    const swt=await sw.text();
    ok(/1\.3\.0|v1\.3/i.test(swt),'Service Worker versionado v1.3');

    console.log(`\nResultado: ${passes} OK · ${fails} falha(s)`);
    process.exit(fails?1:0);
  }catch(e){console.error('FAIL conexão remota — '+(e&&e.message||e));process.exit(1)}
})();
