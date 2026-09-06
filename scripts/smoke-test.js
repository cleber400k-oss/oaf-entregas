'use strict';
const base=(process.env.OAF_SMOKE_URL||process.argv[2]||'http://127.0.0.1:8787').replace(/\/$/,'');
const tests=[];function ok(name,cond,detail=''){tests.push({name,ok:!!cond,detail});if(!cond)process.exitCode=1}
async function get(path){const r=await fetch(base+path,{redirect:'manual'});const text=await r.text();let json=null;try{json=JSON.parse(text)}catch{}return{r,text,json}}
(async()=>{
  try{
    let x=await get('/api/health');ok('health 200',x.r.status===200,`${x.r.status}`);ok('versão 1.3.x',String(x.json?.version||'').startsWith('1.3.'),x.json?.version);
    x=await get('/api/ready');ok('ready responde',x.r.status===200,`${x.r.status}`);ok('database ok',x.json?.database==='ok',x.json?.database);
    x=await get('/');ok('index 200',x.r.status===200,`${x.r.status}`);ok('CSP presente',!!x.r.headers.get('content-security-policy'));
    x=await get('/manifest.webmanifest');ok('manifest 200',x.r.status===200,`${x.r.status}`);
    x=await get('/robots.txt');ok('robots bloqueia indexação',x.text.includes('Disallow: /'));
  }catch(err){ok('conexão com servidor',false,String(err))}
  for(const t of tests)console.log(`${t.ok?'PASS':'FAIL'}  ${t.name}${t.detail?' · '+t.detail:''}`);
  console.log(`\n${tests.filter(t=>t.ok).length}/${tests.length} verificações aprovadas`);
})();
