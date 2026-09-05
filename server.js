'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const APP_VERSION = '1.3.0';
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.OAF_BIND || '0.0.0.0';
const NODE_ENV = String(process.env.OAF_ENV || process.env.NODE_ENV || 'development').toLowerCase();
const IS_PRODUCTION = NODE_ENV === 'production';
const TRUST_PROXY = /^(1|true|yes)$/i.test(String(process.env.OAF_TRUST_PROXY || ''));
const COOKIE_SECURE_MODE = String(process.env.OAF_COOKIE_SECURE || 'auto').toLowerCase();
const RAILWAY_PUBLIC_DOMAIN = String(process.env.RAILWAY_PUBLIC_DOMAIN || '').trim();
const PUBLIC_URL = String(process.env.OAF_PUBLIC_URL || (RAILWAY_PUBLIC_DOMAIN ? `https://${RAILWAY_PUBLIC_DOMAIN}` : '')).replace(/\/$/,'');
const SESSION_HOURS = Math.max(1, Number(process.env.OAF_SESSION_HOURS || 168));
const PUBLIC_DIR = path.join(__dirname, 'public');
const RAILWAY_VOLUME_MOUNT_PATH = String(process.env.RAILWAY_VOLUME_MOUNT_PATH || '').trim();
const DATA_DIR = process.env.OAF_DATA_DIR ? path.resolve(process.env.OAF_DATA_DIR) : RAILWAY_VOLUME_MOUNT_PATH ? path.resolve(RAILWAY_VOLUME_MOUNT_PATH) : path.join(__dirname, 'data');
const LOG_DIR = process.env.OAF_LOG_DIR ? path.resolve(process.env.OAF_LOG_DIR) : RAILWAY_VOLUME_MOUNT_PATH ? path.join(DATA_DIR, 'logs') : path.join(__dirname, 'logs');
const DB_PATH = path.join(DATA_DIR, 'oaf-entregas.sqlite');
const PID_PATH = path.join(DATA_DIR, 'server.pid');
const MAX_BODY = Math.max(1024, Number(process.env.OAF_MAX_BODY_BYTES || 10 * 1024 * 1024));
const DEPLOY_PLATFORM = process.env.RAILWAY_SERVICE_ID ? 'railway' : process.env.RENDER_SERVICE_ID ? 'render' : process.env.FLY_APP_NAME ? 'fly' : 'self-hosted';
const DEPLOY_ENV = String(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RENDER_SERVICE_NAME || process.env.NODE_ENV || NODE_ENV || 'production');
const DEPLOY_ID = String(process.env.RAILWAY_DEPLOYMENT_ID || process.env.RENDER_INSTANCE_ID || process.env.FLY_ALLOC_ID || '');
const REQUIRE_PERSISTENT_STORAGE = /^(1|true|yes)$/i.test(String(process.env.OAF_REQUIRE_PERSISTENT_STORAGE || ''));
if (REQUIRE_PERSISTENT_STORAGE && process.env.RAILWAY_SERVICE_ID && !RAILWAY_VOLUME_MOUNT_PATH) {
  console.error('OAF Entregas: deploy Railway bloqueado — anexe um Volume persistente antes de iniciar a produção.');
  process.exit(78);
}

const STARTED_AT = Date.now();
const STEP_ORDER = ['Aguardando entregador','Atribuída','Indo buscar','Cheguei ao comércio','Mercadoria coletada','Em rota','Cheguei ao destino','Concluída'];
const TERMINAL = new Set(['Concluída','Cancelada']);

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.writeFileSync(PID_PATH, String(process.pid));
const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS app_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  revision INTEGER NOT NULL,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS state_history (
  revision INTEGER PRIMARY KEY,
  json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_users (
  user_id TEXT PRIMARY KEY,
  login TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  csrf TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS server_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

function now(){ return Date.now(); }
function clone(v){ return v == null ? v : JSON.parse(JSON.stringify(v)); }
function jEq(a,b){ return JSON.stringify(a) === JSON.stringify(b); }
function norm(s){ return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim(); }
function randHex(n=32){ return crypto.randomBytes(n).toString('hex'); }
function sha256(s){ return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function hashPassword(password){
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}
function verifyPassword(password, stored){
  try{
    const [kind,salt,hex] = String(stored).split('$');
    if(kind !== 'scrypt' || !salt || !hex) return false;
    const got = crypto.scryptSync(String(password), salt, 64);
    const expected = Buffer.from(hex,'hex');
    return expected.length === got.length && crypto.timingSafeEqual(expected,got);
  }catch{return false;}
}
function emptyState(){
  return {
    meta:{version:1,createdAt:now(),release:APP_VERSION,mode:'production-server',setupComplete:false},
    settings:{supportPhone:''},
    users:[],merchants:[],couriers:[],deliveries:[],charges:[],complaints:[],occurrences:[],
    addressDatabase:[],addressReviews:[],logoutRequests:[],internalMessages:[],audit:[],
    paymentSettings:{pixKey:'',pixRecipient:'',pixInstructions:'Confirme os dados diretamente com a administração antes de efetuar o pagamento.'},
    paymentSubmissions:[],billingNotifications:[]
  };
}
function ensureState(){
  let row = db.prepare('SELECT revision,json FROM app_state WHERE id=1').get();
  if(!row){
    const s=emptyState(), text=JSON.stringify(s), t=now();
    db.prepare('INSERT INTO app_state(id,revision,json,updated_at) VALUES(1,0,?,?)').run(text,t);
    db.prepare('INSERT OR REPLACE INTO state_history(revision,json,created_at) VALUES(0,?,?)').run(text,t);
    row={revision:0,json:text};
  }
  return {revision:Number(row.revision),state:JSON.parse(row.json)};
}
function getState(){
  const row=db.prepare('SELECT revision,json FROM app_state WHERE id=1').get();
  if(!row)return ensureState();
  return {revision:Number(row.revision),state:JSON.parse(row.json)};
}
function getHistory(rev){
  const row=db.prepare('SELECT json FROM state_history WHERE revision=?').get(Number(rev));
  return row?JSON.parse(row.json):null;
}
function scrubState(state){
  const s=clone(state);
  for(const u of s.users||[])u.password='';
  return s;
}
function presentState(state,actor){
  const s=scrubState(state);if(!actor||actor.role==='admin')return s;
  const common={meta:s.meta,settings:{supportPhone:s.settings?.supportPhone||''},addressDatabase:s.addressDatabase||[]};
  if(actor.role==='merchant'){
    const mid=actor.merchantId,deliveries=(s.deliveries||[]).filter(d=>d.merchantId===mid),deliveryIds=new Set(deliveries.map(d=>d.id)),courierIds=new Set(deliveries.map(d=>d.courierId).filter(Boolean));
    const couriers=(s.couriers||[]).filter(c=>courierIds.has(c.id)).map(c=>({id:c.id,nick:c.nick,status:c.status,online:!!c.online,queue:c.queue||0}));
    return {...common,users:(s.users||[]).filter(u=>u.id===actor.id),merchants:(s.merchants||[]).filter(m=>m.id===mid),couriers,deliveries,charges:(s.charges||[]).filter(c=>c.merchantId===mid),complaints:(s.complaints||[]).filter(x=>x.merchantId===mid),occurrences:(s.occurrences||[]).filter(x=>x.merchantId===mid),addressReviews:(s.addressReviews||[]).filter(x=>x.merchantId===mid),logoutRequests:[],internalMessages:(s.internalMessages||[]).filter(x=>x.merchantId===mid||(!x.courierId&&deliveryIds.has(x.deliveryId))),audit:[],paymentSettings:s.paymentSettings||{},paymentSubmissions:(s.paymentSubmissions||[]).filter(x=>x.merchantId===mid),billingNotifications:(s.billingNotifications||[]).filter(x=>x.merchantId===mid)};
  }
  if(actor.role==='courier'){
    const cid=actor.courierId,deliveries=(s.deliveries||[]).filter(d=>d.courierId===cid).map(d=>{const x=clone(d);delete x.price;return x}),merchantIds=new Set(deliveries.map(d=>d.merchantId).filter(Boolean));
    const couriers=(s.couriers||[]).map(c=>c.id===cid?clone(c):({id:c.id,nick:c.nick,online:!!c.online,adminBlocked:!!c.adminBlocked,status:c.status,gps:c.gps!==false,connection:c.connection!==false,queue:c.queue||0}));
    return {...common,users:(s.users||[]).filter(u=>u.id===actor.id),merchants:(s.merchants||[]).filter(m=>merchantIds.has(m.id)).map(m=>({id:m.id,name:m.name,address:m.address,district:m.district||'',phone:m.phone||''})),couriers,deliveries,charges:[],complaints:[],occurrences:(s.occurrences||[]).filter(x=>x.courierId===cid),addressReviews:(s.addressReviews||[]).filter(x=>x.courierId===cid),logoutRequests:(s.logoutRequests||[]).filter(x=>x.courierId===cid),internalMessages:(s.internalMessages||[]).filter(x=>x.courierId===cid),audit:[],paymentSettings:{},paymentSubmissions:[],billingNotifications:[]};
  }
  return common;
}
function putState(state, reason='sync'){
  state.meta={...(state.meta||{}),release:APP_VERSION,mode:'production-server',serverUpdatedAt:now()};
  const current=getState();
  const revision=current.revision+1, t=now();
  db.exec('BEGIN IMMEDIATE');
  try{
    reconcileAuth(state);
    for(const u of state.users||[])u.password='';
    const text=JSON.stringify(state);
    db.prepare('UPDATE app_state SET revision=?,json=?,updated_at=? WHERE id=1').run(revision,text,t);
    db.prepare('INSERT OR REPLACE INTO state_history(revision,json,created_at) VALUES(?,?,?)').run(revision,text,t);
    db.prepare('DELETE FROM state_history WHERE revision < ?').run(Math.max(0,revision-80));
    db.exec('COMMIT');
  }catch(err){try{db.exec('ROLLBACK')}catch{};throw err}
  broadcast(revision,reason);
  return {revision,state};
}

function getMeta(key){ return db.prepare('SELECT value FROM server_meta WHERE key=?').get(key)?.value ?? null; }
function setMeta(key,value){ db.prepare('INSERT OR REPLACE INTO server_meta(key,value) VALUES(?,?)').run(key,String(value)); }
function setupCode(){
  let code=getMeta('setup_code');
  if(!code){ code=String(process.env.OAF_SETUP_CODE || crypto.randomInt(100000,999999)); setMeta('setup_code',code); }
  return code;
}
function isSetup(){ return !!(getState().state.users||[]).some(u=>u.role==='admin'&&u.main&&u.active); }

function reconcileAuth(state){
  const users=state.users||[];
  const seen=new Set();
  const upsert=db.prepare(`INSERT INTO auth_users(user_id,login,password_hash,role,active,updated_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET login=excluded.login,role=excluded.role,active=excluded.active,updated_at=excluded.updated_at`);
  const changePass=db.prepare('UPDATE auth_users SET password_hash=?,updated_at=? WHERE user_id=?');
  for(const u of users){
    if(!u?.id||!u?.login)continue;
    seen.add(u.id);
    const existing=db.prepare('SELECT password_hash FROM auth_users WHERE user_id=?').get(u.id);
    const incoming=String(u.password||'');
    const passHash=incoming?hashPassword(incoming):(existing?.password_hash||'');
    if(!passHash)continue;
    upsert.run(u.id,String(u.login),passHash,String(u.role||''),u.active===false?0:1,now());
    if(incoming&&existing)changePass.run(passHash,now(),u.id);
  }
  const rows=db.prepare('SELECT user_id FROM auth_users').all();
  for(const r of rows)if(!seen.has(r.user_id))db.prepare('DELETE FROM auth_users WHERE user_id=?').run(r.user_id);
}

function activeDelivery(state,courierId){return (state.deliveries||[]).find(d=>d.courierId===courierId&&!TERMINAL.has(d.status));}
function normalizeQueue(state){
  const online=(state.couriers||[]).filter(c=>c.online&&!c.adminBlocked).sort((a,b)=>(a.queue||999999)-(b.queue||999999));
  online.forEach((c,i)=>c.queue=i+1);
  for(const c of state.couriers||[])if(!c.online)c.queue=0;
}
function serverQueueEngine(state,reason='Servidor'){
  normalizeQueue(state);
  for(const c of state.couriers||[]){
    const d=activeDelivery(state,c.id);
    c.status=d?d.status:(c.online?'Disponível':'Offline');
  }
  const waiting=(state.deliveries||[]).filter(d=>d.status==='Aguardando entregador').sort((a,b)=>(a.createdAt||0)-(b.createdAt||0));
  for(const d of waiting){
    const available=(state.couriers||[]).filter(c=>c.online&&!c.adminBlocked&&c.gps!==false&&c.connection!==false&&c.status==='Disponível'&&!activeDelivery(state,c.id)).sort((a,b)=>(a.queue||9999)-(b.queue||9999));
    const c=available[0]; if(!c)break;
    d.courierId=c.id;d.status='Atribuída';d.assignedAt=now();d.nudgeCount=0;d.history=Array.isArray(d.history)?d.history:[];d.history.push([`Atribuída a ${c.nick}`,now()]);c.status='Atribuída';
    state.internalMessages=state.internalMessages||[];
    const exists=state.internalMessages.some(m=>m.deliveryId===d.id&&m.courierId===c.id&&/Nova entrega/.test(m.msg||''));
    if(!exists)state.internalMessages.push({id:`M-${now()}-${c.id}-${Math.random().toString(36).slice(2,5)}`,courierId:c.id,msg:`Nova entrega ${d.id} atribuída. Inicie a coleta.`,level:'Importante',at:now(),read:false,requiresAck:true,readAt:null,deliveryId:d.id});
    appendAudit(state,`Fila atribuiu ${d.id} a ${c.nick}`,{reason},null,'Sistema');
  }
  normalizeQueue(state);
}
function appendAudit(state,action,details,userId,by){
  state.audit=state.audit||[];
  state.audit.unshift({id:`AU-${now()}-${Math.random().toString(36).slice(2,6)}`,action,details:details||{},by:by||'Sistema',userId:userId||null,at:now()});
  if(state.audit.length>5000)state.audit.length=5000;
}
function monthLastDay(year,month){return new Date(year,month+1,0).getDate()}
function monthDayFromBilling(value,fallback=5){const found=String(value||'').match(/\d{1,2}/);const day=Number(found?.[0]);return Number.isInteger(day)&&day>=1&&day<=31?day:fallback}
function billingWeekday(value){const n=norm(value), names={domingo:0,segunda:1,'segunda-feira':1,terca:2,'terca-feira':2,quarta:3,'quarta-feira':3,quinta:4,'quinta-feira':4,sexta:5,'sexta-feira':5,sabado:6};return Object.entries(names).find(([name])=>n.includes(name))?.[1]??null}
function periodDateText(start,end){return start.toLocaleDateString('pt-BR')+' a '+end.toLocaleDateString('pt-BR')}
function billingCycleInfo(m,ts=now()){
  const d=new Date(ts),y=d.getFullYear(),mo=d.getMonth(),day=d.getDate();
  if(m.billing==='Mensal'){
    const start=new Date(y,mo,1),end=new Date(y,mo+1,0,23,59,59,999),dueDay=monthDayFromBilling(m.billingDay,5),dueMonth=mo+1,due=new Date(y,dueMonth,Math.min(dueDay,monthLastDay(y,dueMonth)),23,59,59,999);
    return{key:`${y}-${String(mo+1).padStart(2,'0')}`,period:periodDateText(start,end),dueTs:due.getTime(),due:due.toLocaleDateString('pt-BR')};
  }
  if(m.billing==='Quinzenal'){
    const first=day<=15,start=new Date(y,mo,first?1:16,0,0,0,0),end=first?new Date(y,mo,15,23,59,59,999):new Date(y,mo+1,0,23,59,59,999),due=new Date(end);due.setDate(due.getDate()+2);
    return{key:`${y}-${String(mo+1).padStart(2,'0')}-${first?'Q1':'Q2'}`,period:periodDateText(start,end),dueTs:due.getTime(),due:due.toLocaleDateString('pt-BR')};
  }
  const target=billingWeekday(m.billingDay)??1,current=d.getDay(),days=(target-current+7)%7,end=new Date(y,mo,day+days,23,59,59,999),start=new Date(end);start.setDate(end.getDate()-6);start.setHours(0,0,0,0);
  return{key:`W-${start.getFullYear()}-${String(start.getMonth()+1).padStart(2,'0')}-${String(start.getDate()).padStart(2,'0')}`,period:periodDateText(start,end),dueTs:end.getTime(),due:end.toLocaleDateString('pt-BR')};
}
function addDeliveryToChargeServer(state,d){
  const m=(state.merchants||[]).find(x=>x.id===d.merchantId);if(!m)return;
  const cycle=billingCycleInfo(m,d.finishedAt||now());state.charges=state.charges||[];
  let c=state.charges.find(x=>x.merchantId===m.id&&x.cycleKey===cycle.key&&x.status!=='Pago');
  if(!c){c={id:`C-${now()}-${Math.random().toString(36).slice(2,5)}`,merchantId:m.id,cycleKey:cycle.key,period:cycle.period,count:0,total:0,due:cycle.due,dueTs:cycle.dueTs,status:'Em aberto',deliveryIds:[]};state.charges.push(c)}
  c.deliveryIds=c.deliveryIds||[];if(!c.deliveryIds.includes(d.id)){c.deliveryIds.push(d.id);c.count+=1;c.total=Number((Number(c.total||0)+Number(d.price||m.fee||0)).toFixed(2))}
}
function serverFinanceRules(state){
  const t=now();state.billingNotifications=state.billingNotifications||[];
  const known=new Set(state.billingNotifications.map(n=>`${n.chargeId}:${n.type}`));
  for(const c of state.charges||[]){
    if(c.status!=='Pago')c.status=c.dueTs&&t>c.dueTs?'Vencido':'Em aberto';
    if(c.status==='Pago')continue;
    const diff=(c.dueTs||0)-t,type=c.status==='Vencido'?'overdue':diff>0&&diff<=2*86400000?'dueSoon':'';
    if(type&&!known.has(`${c.id}:${type}`)){state.billingNotifications.unshift({id:`BN-${now()}-${c.id}`,merchantId:c.merchantId,chargeId:c.id,type,createdAt:now()});known.add(`${c.id}:${type}`)}
  }
}
function serverRules(state,reason='Sincronização'){
  serverFinanceRules(state);serverQueueEngine(state,reason);return state;
}

function mapById(arr){const m=new Map();for(const x of arr||[])if(x&&x.id)m.set(x.id,x);return m}
function collectionDiff(baseArr,clientArr){
  const b=mapById(baseArr),c=mapById(clientArr),ids=new Set([...b.keys(),...c.keys()]),out=[];
  for(const id of ids){const before=b.get(id),after=c.get(id);if(!jEq(before,after))out.push({id,before,after,deleted:!!before&&!after,added:!before&&!!after});}
  return out;
}
function permissions(actor){return new Set(actor?.permissions||[])}
function has(actor,p){return !!actor&&(actor.main||permissions(actor).has('*')||permissions(actor).has(p))}
function findActor(state,userId){return (state.users||[]).find(u=>u.id===userId&&u.active)}
function safeHistory(before,after){
  const old=Array.isArray(before?.history)?before.history:[], neu=Array.isArray(after?.history)?after.history:[];
  return neu.length>=old.length?neu:old;
}
function mergeDeliveryChange(result,before,after,actor){
  result.deliveries=result.deliveries||[];const idx=result.deliveries.findIndex(d=>d.id===(after||before)?.id),cur=idx>=0?result.deliveries[idx]:null;
  if(actor.role==='admin'){
    if(!(actor.main||has(actor,'deliveries_manage')))return;
    if(after){if(idx>=0)result.deliveries[idx]=clone(after);else result.deliveries.unshift(clone(after));}else if(actor.main&&idx>=0)result.deliveries.splice(idx,1);return;
  }
  if(actor.role==='merchant'){
    const mid=actor.merchantId;if(after&&!before){
      if(after.merchantId!==mid)return;const m=(result.merchants||[]).find(x=>x.id===mid);if(!m)return;
      const d=clone(after);d.merchantId=mid;d.courierId=null;d.status='Aguardando entregador';d.createdAt=now();d.price=Number(m.fee||0);d.assignedAt=null;d.finishedAt=null;d.receivedBy='';d.nudgeCount=0;d.history=[['Criada',now()]];result.deliveries.unshift(d);return;
    }
    if(!cur||cur.merchantId!==mid||!after)return;
    const d=clone(cur), editable=['recipient','phone','street','number','district','complement','reference','volume','notes'];
    if(!TERMINAL.has(cur.status))for(const k of editable)if(after[k]!==undefined)d[k]=clone(after[k]);
    if(cur.status==='Aguardando entregador'&&after.status==='Cancelada'){d.status='Cancelada';d.cancelledAt=after.cancelledAt||now();d.history=safeHistory(cur,after)}
    result.deliveries[idx]=d;return;
  }
  if(actor.role==='courier'){
    if(!cur||cur.courierId!==actor.courierId||!after)return;
    const d=clone(cur),ci=STEP_ORDER.indexOf(cur.status),ni=STEP_ORDER.indexOf(after.status);
    if(ni===ci+1)d.status=after.status;
    const allow=['receivedBy','finishedAt','deliveryIssue','deliveryIssueNote','notes'];for(const k of allow)if(after[k]!==undefined)d[k]=clone(after[k]);
    d.history=safeHistory(cur,after);result.deliveries[idx]=d;return;
  }
}
function mergeCourierChange(result,before,after,actor){
  result.couriers=result.couriers||[];const id=(after||before)?.id,idx=result.couriers.findIndex(x=>x.id===id),cur=idx>=0?result.couriers[idx]:null;
  if(actor.role==='admin'){
    const creating=!before&&!!after;if(!actor.main&&!(creating&&has(actor,'users_create_courier')))return;
    if(after){if(idx>=0)result.couriers[idx]=clone(after);else result.couriers.push(clone(after));}return;
  }
  if(actor.role==='courier'&&id===actor.courierId&&cur&&after){
    const c=clone(cur);for(const k of ['online','connection','gps','lastPing','connectionLostAt'])if(after[k]!==undefined)c[k]=clone(after[k]);result.couriers[idx]=c;
  }
}
function mergeMerchantChange(result,before,after,actor){
  result.merchants=result.merchants||[];const id=(after||before)?.id,idx=result.merchants.findIndex(x=>x.id===id);
  if(actor.role==='admin'&&after){const creating=!before;if(!actor.main&&!(creating&&has(actor,'users_create_merchant')))return;if(idx>=0)result.merchants[idx]=clone(after);else result.merchants.push(clone(after));}
}
function mergeUserChange(result,before,after,actor){
  result.users=result.users||[];const id=(after||before)?.id,idx=result.users.findIndex(x=>x.id===id),cur=idx>=0?result.users[idx]:null;
  if(actor.role!=='admin'||!after)return;
  if(actor.main){if(idx>=0)result.users[idx]=clone(after);else result.users.push(clone(after));return;}
  if(before)return; // secundário só pode criar tipos autorizados
  if(after.role==='merchant'&&has(actor,'users_create_merchant'))result.users.push(clone(after));
  if(after.role==='courier'&&has(actor,'users_create_courier'))result.users.push(clone(after));
}
function relatedDelivery(state,id){return (state.deliveries||[]).find(d=>d.id===id)}
function mergeSimpleCollection(result,name,baseArr,clientArr,actor){
  result[name]=result[name]||[];const curMap=mapById(result[name]);
  for(const ch of collectionDiff(baseArr,clientArr)){
    if(ch.deleted){if(actor.role==='admin'&&actor.main)result[name]=result[name].filter(x=>x.id!==ch.id);continue}
    const x=clone(ch.after);let allowed=false;
    if(actor.role==='admin'){
      const needed={complaints:'complaints_manage',occurrences:'occurrences_manage',addressReviews:'addresses_manage',logoutRequests:'users_view',internalMessages:'monitor_message',paymentSubmissions:'finance_confirm'}[name];
      allowed=actor.main||!needed||has(actor,needed);
    }
    else if(actor.role==='merchant'){
      if(name==='complaints'||name==='paymentSubmissions'||name==='occurrences')allowed=x.merchantId===actor.merchantId;
      if(name==='internalMessages'){const d=relatedDelivery(result,x.deliveryId);allowed=!!d&&d.merchantId===actor.merchantId;}
    }else if(actor.role==='courier'){
      if(name==='addressReviews'||name==='logoutRequests'||name==='occurrences')allowed=x.courierId===actor.courierId;
      if(name==='internalMessages')allowed=x.courierId===actor.courierId;
    }
    if(!allowed)continue;
    const idx=result[name].findIndex(e=>e.id===x.id),cur=idx>=0?result[name][idx]:null;
    if(actor.role==='courier'&&name==='internalMessages'&&cur){const y=clone(cur);y.read=!!x.read;y.readAt=x.readAt||y.readAt;if(idx>=0)result[name][idx]=y;continue}
    if(idx>=0)result[name][idx]=x;else result[name].push(x);
  }
}
function mergeAudit(result,baseArr,clientArr,actor){
  result.audit=result.audit||[];const baseIds=new Set((baseArr||[]).map(x=>x.id));const currentIds=new Set(result.audit.map(x=>x.id));
  for(const x of clientArr||[]){if(!x?.id||baseIds.has(x.id)||currentIds.has(x.id))continue;appendAudit(result,String(x.action||'Ação no aplicativo'),clone(x.details||{}),actor.id,actor.name);currentIds.add(x.id)}
}
function mergeSettings(result,base,client,actor){
  if(actor.role!=='admin')return;result.settings=result.settings||{};for(const [k,v] of Object.entries(client||{}))if(!jEq(base?.[k],v))result.settings[k]=clone(v);
  if(actor.main){result.paymentSettings=result.paymentSettings||{};for(const [k,v] of Object.entries(client?.__payment||{}))result.paymentSettings[k]=clone(v)}
}
function mergeCharges(result,baseArr,clientArr,actor){
  if(actor.role==='admin'){if(actor.main||has(actor,'finance_confirm')||has(actor,'finance_adjust'))result.charges=clone(clientArr||[]);return}
  if(actor.role!=='merchant')return;
  const curMap=mapById(result.charges||[]),b=mapById(baseArr||[]),c=mapById(clientArr||[]);
  for(const [id,after] of c){const before=b.get(id);if(jEq(before,after))continue;const cur=curMap.get(id);if(!cur||cur.merchantId!==actor.merchantId)continue;const y=clone(cur);for(const k of ['paymentProofReference','paymentProofPendingAt']){if(after[k]!==undefined)y[k]=after[k];else if(before&&before[k]!==undefined&&after[k]===undefined)delete y[k]}const idx=result.charges.findIndex(x=>x.id===id);result.charges[idx]=y;}
}
function threeWayMerge(base,client,current,actor){
  const result=clone(current);
  for(const ch of collectionDiff(base.users,client.users))mergeUserChange(result,ch.before,ch.after,actor);
  for(const ch of collectionDiff(base.merchants,client.merchants))mergeMerchantChange(result,ch.before,ch.after,actor);
  for(const ch of collectionDiff(base.couriers,client.couriers))mergeCourierChange(result,ch.before,ch.after,actor);
  for(const ch of collectionDiff(base.deliveries,client.deliveries))mergeDeliveryChange(result,ch.before,ch.after,actor);
  for(const name of ['complaints','occurrences','addressReviews','logoutRequests','internalMessages','paymentSubmissions'])mergeSimpleCollection(result,name,base[name],client[name],actor);
  if(actor.role==='admin'&&(actor.main||has(actor,'addresses_manage')))result.addressDatabase=clone(client.addressDatabase||result.addressDatabase||[]);
  // billingNotifications é calculado exclusivamente pelo servidor.
  mergeCharges(result,base.charges,client.charges,actor);
  mergeAudit(result,base.audit,client.audit,actor);
  if(actor.role==='admin'&&actor.main){
    result.settings={...(result.settings||{})};for(const [k,v] of Object.entries(client.settings||{}))if(!jEq(base.settings?.[k],v))result.settings[k]=clone(v);
    result.paymentSettings=clone(client.paymentSettings||result.paymentSettings||{});result.meta={...(result.meta||{}),...(client.meta||{})};
  }
  // Detecta conclusões recém-aplicadas e fecha o financeiro/fila no servidor.
  const baseD=mapById(current.deliveries||[]);for(const d of result.deliveries||[]){const old=baseD.get(d.id);if(old&&old.status!=='Concluída'&&d.status==='Concluída'){
    d.finishedAt=d.finishedAt||now();addDeliveryToChargeServer(result,d);const c=(result.couriers||[]).find(x=>x.id===d.courierId);if(c){c.deliveriesToday=Number(c.deliveriesToday||0)+1;const max=Math.max(0,...(result.couriers||[]).filter(x=>x.online&&!x.adminBlocked&&x.id!==c.id).map(x=>Number(x.queue||0)));c.queue=max+1;c.status='Disponível';}
  }}
  return serverRules(result,'Sincronização do aplicativo');
}

function parseCookies(req){const out={};for(const p of String(req.headers.cookie||'').split(';')){const i=p.indexOf('=');if(i>0)out[p.slice(0,i).trim()]=decodeURIComponent(p.slice(i+1).trim())}return out}
function cookie(name,value,maxAge,secure=false){return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Priority=High; Max-Age=${maxAge}${secure?'; Secure':''}`}
function forwardedProto(req){return TRUST_PROXY?String(req.headers['x-forwarded-proto']||'').split(',')[0].trim().toLowerCase():''}
function isSecure(req){return COOKIE_SECURE_MODE==='1'||COOKIE_SECURE_MODE==='true'||COOKIE_SECURE_MODE==='yes'||!!req.socket.encrypted||forwardedProto(req)==='https'}
function cleanupSessions(){db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now())}
function sessionFromReq(req){
  cleanupSessions();const raw=parseCookies(req).oaf_session;if(!raw)return null;const hash=sha256(raw),row=db.prepare('SELECT user_id,csrf,expires_at FROM sessions WHERE token_hash=?').get(hash);if(!row||row.expires_at<now())return null;
  const {state}=getState(),user=findActor(state,row.user_id);if(!user||user.active===false)return null;return{token:raw,csrf:row.csrf,user};
}
function createSession(req,userId){
  const token=randHex(32),csrf=randHex(18),exp=now()+SESSION_HOURS*3600000;db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);db.prepare('INSERT INTO sessions(token_hash,user_id,csrf,expires_at,created_at) VALUES(?,?,?,?,?)').run(sha256(token),userId,csrf,exp,now());return{token,csrf,exp,secure:isSecure(req)};
}
function requireAuth(req,res){const s=sessionFromReq(req);if(!s){json(res,401,{ok:false,error:'Sessão expirada ou não autenticada.'});return null}return s}
function requireCsrf(req,res,s){if(req.headers['x-oaf-csrf']!==s.csrf){json(res,403,{ok:false,error:'Token de segurança inválido.'});return false}return true}

const loginAttempts=new Map();
function clientIp(req){const raw=TRUST_PROXY?String(req.headers['x-forwarded-for']||req.headers['x-real-ip']||req.socket.remoteAddress||''):String(req.socket.remoteAddress||'');return raw.split(',')[0].trim()}
function loginGate(req){const ip=clientIp(req),r=loginAttempts.get(ip)||{count:0,until:0};if(r.until>now())return{blocked:true,minutes:Math.ceil((r.until-now())/60000)};return{blocked:false,record:r,ip}}
function loginFail(g){const r=g.record;r.count++;if(r.count>=5){r.count=0;r.until=now()+15*60000}loginAttempts.set(g.ip,r)}
function loginOk(g){loginAttempts.delete(g.ip)}

function logLine(level,message,meta={}){
  const row=JSON.stringify({at:new Date().toISOString(),level,message,...meta});
  if(level==='error')console.error(row);else console.log(row);
  try{fs.appendFileSync(path.join(LOG_DIR,'oaf-entregas.log'),row+'\n')}catch{}
}
function securityHeaders(req,res){
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','same-origin');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');
  res.setHeader('Cross-Origin-Resource-Policy','same-origin');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  if(isSecure(req))res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');
}
function requestLog(req,res,url){
  const started=Date.now();
  res.on('finish',()=>{if(url.pathname==='/api/events')return;logLine('info','http',{method:req.method,path:url.pathname,status:res.statusCode,ms:Date.now()-started,ip:clientIp(req)});});
}
function json(res,status,obj,headers={}){const body=JSON.stringify(obj);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(body)}
function text(res,status,body,type='text/plain; charset=utf-8',headers={}){res.writeHead(status,{'Content-Type':type,...headers});res.end(body)}
function readJson(req){return new Promise((resolve,reject)=>{let chunks=[],size=0;req.on('data',c=>{size+=c.length;if(size>MAX_BODY){reject(new Error('Corpo da requisição muito grande'));req.destroy();return}chunks.push(c)});req.on('end',()=>{try{resolve(chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):{})}catch(e){reject(new Error('JSON inválido'))}});req.on('error',reject)})}
function mime(file){const e=path.extname(file).toLowerCase();return({'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.css':'text/css; charset=utf-8','.txt':'text/plain; charset=utf-8'}[e]||'application/octet-stream')}

const sseClients=new Set();
function broadcast(revision,reason){const data=`event: state\ndata: ${JSON.stringify({revision,reason,at:now()})}\n\n`;for(const res of [...sseClients]){try{res.write(data)}catch{sseClients.delete(res)}}}
setInterval(()=>{for(const res of [...sseClients]){try{res.write(': ping\n\n')}catch{sseClients.delete(res)}}},25000).unref();

async function api(req,res,url){
  if(req.method==='GET'&&url.pathname==='/api/health'){let database='ok';try{db.prepare('SELECT 1 AS ok').get()}catch{database='error'}return json(res,database==='ok'?200:503,{ok:database==='ok',service:'OAF Entregas Backend',version:APP_VERSION,time:now(),uptimeSeconds:Math.floor((now()-STARTED_AT)/1000),database,platform:DEPLOY_PLATFORM,environment:DEPLOY_ENV,deploymentId:DEPLOY_ID||null,persistentStorage:process.env.RAILWAY_SERVICE_ID?!!RAILWAY_VOLUME_MOUNT_PATH:true});}
  if(req.method==='GET'&&url.pathname==='/api/ready'){let database='ok';try{db.prepare('SELECT revision FROM app_state WHERE id=1').get()}catch{database='error'}return json(res,database==='ok'?200:503,{ok:database==='ok',version:APP_VERSION,setupComplete:isSetup(),database,platform:DEPLOY_PLATFORM,environment:DEPLOY_ENV,deploymentId:DEPLOY_ID||null,persistentStorage:process.env.RAILWAY_SERVICE_ID?!!RAILWAY_VOLUME_MOUNT_PATH:true});}
  if(req.method==='GET'&&url.pathname==='/api/config')return json(res,200,{ok:true,version:APP_VERSION,setupRequired:!isSetup(),realtime:'sse',database:'sqlite',production:IS_PRODUCTION,publicUrl:PUBLIC_URL||null,secureContext:isSecure(req),platform:DEPLOY_PLATFORM,environment:DEPLOY_ENV,persistentStorage:process.env.RAILWAY_SERVICE_ID?!!RAILWAY_VOLUME_MOUNT_PATH:true});
  if(req.method==='POST'&&url.pathname==='/api/setup'){
    if(isSetup())return json(res,409,{ok:false,error:'O servidor já foi configurado.'});
    const body=await readJson(req);if(String(body.setupCode||'')!==setupCode())return json(res,403,{ok:false,error:'Código de configuração inválido.'});
    let state;
    if(body.importState){
      state=clone(body.importState);const main=(state.users||[]).find(u=>u.role==='admin'&&u.main&&u.active&&String(u.password||'').length>=4);if(!main)return json(res,400,{ok:false,error:'A base local não possui Administrador Principal com senha válida para migração.'});
      state.meta={...(state.meta||{}),setupComplete:true,release:APP_VERSION,mode:'production-server',migratedAt:now()};
    }else{
      const name=String(body.name||'').trim(),login=String(body.login||'').trim(),password=String(body.password||''),supportPhone=String(body.supportPhone||'').replace(/\D/g,'').slice(0,13);
      if(!name||!login||password.length<4)return json(res,400,{ok:false,error:'Informe nome, login e senha com pelo menos 4 caracteres.'});
      state=emptyState();const uid=`u-${now()}`;state.users.push({id:uid,login,password,role:'admin',name,main:true,permissions:['*'],active:true,mustChangePassword:false});state.settings.supportPhone=supportPhone;state.meta={...state.meta,setupComplete:true};appendAudit(state,'Configuração inicial do servidor concluída',{release:APP_VERSION},uid,name);
    }
    serverRules(state,'Configuração inicial');const saved=putState(state,'Configuração inicial');setMeta('setup_complete','1');
    const main=saved.state.users.find(u=>u.role==='admin'&&u.main&&u.active);const sess=createSession(req,main.id);const headers={'Set-Cookie':cookie('oaf_session',sess.token,SESSION_HOURS*3600,sess.secure)};
    return json(res,200,{ok:true,user:scrubUser(main),csrf:sess.csrf,revision:saved.revision,state:presentState(saved.state,main)},headers);
  }
  if(req.method==='POST'&&url.pathname==='/api/login'){
    if(!isSetup())return json(res,409,{ok:false,error:'Servidor ainda não configurado.'});const g=loginGate(req);if(g.blocked)return json(res,429,{ok:false,error:`Muitas tentativas. Aguarde ${g.minutes} minuto(s).`});
    const body=await readJson(req),login=String(body.login||'').trim(),password=String(body.password||'');const row=db.prepare('SELECT user_id,password_hash,active FROM auth_users WHERE login=? COLLATE NOCASE').get(login);
    if(!row||!row.active||!verifyPassword(password,row.password_hash)){loginFail(g);return json(res,401,{ok:false,error:'Login ou senha inválidos.'})}loginOk(g);
    let current=getState();let user=findActor(current.state,row.user_id);if(!user)return json(res,401,{ok:false,error:'Usuário não encontrado na base.'});
    if(user.role==='courier'){const c=(current.state.couriers||[]).find(x=>x.id===user.courierId);if(!c||c.adminBlocked)return json(res,403,{ok:false,error:'Esta conta está suspensa pela Administração.'});c.online=true;c.connection=true;c.gps=true;c.lastPing=now();if(!c.queue)c.queue=Math.max(0,...current.state.couriers.filter(x=>x.online&&!x.adminBlocked&&x.id!==c.id).map(x=>Number(x.queue||0)))+1;serverRules(current.state,'Login de entregador');current=putState(current.state,'Login de entregador');user=findActor(current.state,row.user_id);}
    const sess=createSession(req,row.user_id),headers={'Set-Cookie':cookie('oaf_session',sess.token,SESSION_HOURS*3600,sess.secure)};
    appendAudit(current.state,'Login realizado via servidor',{},user.id,user.name);current=putState(current.state,'Login');
    return json(res,200,{ok:true,user:scrubUser(user),csrf:sess.csrf,revision:current.revision,state:presentState(current.state,user)},headers);
  }
  if(req.method==='POST'&&url.pathname==='/api/logout'){
    const s=requireAuth(req,res);if(!s)return;if(!requireCsrf(req,res,s))return;db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha256(s.token));return json(res,200,{ok:true},{'Set-Cookie':cookie('oaf_session','',0,isSecure(req))});
  }
  if(req.method==='GET'&&url.pathname==='/api/session'){
    const s=sessionFromReq(req);if(!s)return json(res,200,{ok:true,authenticated:false});let current=getState();serverRules(current.state,'Leitura de sessão');const before=JSON.stringify(getState().state),after=JSON.stringify(current.state);if(before!==after)current=putState(current.state,'Regras do servidor');
    const user=findActor(current.state,s.user.id);return json(res,200,{ok:true,authenticated:true,user:scrubUser(user),csrf:s.csrf,revision:current.revision,state:presentState(current.state,user)});
  }
  if(req.method==='GET'&&url.pathname==='/api/state'){
    const s=requireAuth(req,res);if(!s)return;let current=getState();const pre=JSON.stringify(current.state);serverRules(current.state,'Atualização automática');if(pre!==JSON.stringify(current.state))current=putState(current.state,'Atualização automática');const actor=findActor(current.state,s.user.id);return json(res,200,{ok:true,revision:current.revision,state:presentState(current.state,actor)});
  }
  if(req.method==='PUT'&&url.pathname==='/api/state'){
    const s=requireAuth(req,res);if(!s)return;if(!requireCsrf(req,res,s))return;const body=await readJson(req);const current=getState(),baseRev=Number(body.baseRevision);let base=Number.isFinite(baseRev)?getHistory(baseRev):null;if(!base)base=current.state;
    const actor=findActor(current.state,s.user.id);if(!actor)return json(res,401,{ok:false,error:'Usuário não encontrado.'});const client=body.state;if(!client||typeof client!=='object')return json(res,400,{ok:false,error:'Estado inválido.'});
    const merged=threeWayMerge(base,client,current.state,actor);const saved=putState(merged,`Sincronização · ${actor.role}`);return json(res,200,{ok:true,revision:saved.revision,state:presentState(saved.state,findActor(saved.state,actor.id))});
  }
  if(req.method==='GET'&&url.pathname==='/api/events'){
    const s=requireAuth(req,res);if(!s)return;res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});res.write(`event: hello\ndata: ${JSON.stringify({revision:getState().revision,at:now()})}\n\n`);sseClients.add(res);req.on('close',()=>sseClients.delete(res));return;
  }
  return json(res,404,{ok:false,error:'Rota não encontrada.'});
}
function scrubUser(u){if(!u)return null;const x=clone(u);delete x.password;return x}
function staticFile(req,res,url){
  let rel=decodeURIComponent(url.pathname);if(rel==='/'||rel==='')rel='/index.html';const file=path.resolve(PUBLIC_DIR,'.'+rel);if(!file.startsWith(PUBLIC_DIR+path.sep)&&file!==PUBLIC_DIR)return text(res,403,'Acesso negado');
  fs.stat(file,(err,st)=>{if(err||!st.isFile())return text(res,404,'Arquivo não encontrado');const headers={'Content-Type':mime(file)};if(path.basename(file)==='index.html'||path.extname(file)==='.js'||path.extname(file)==='.webmanifest')headers['Cache-Control']='no-cache';else headers['Cache-Control']='public, max-age=86400';res.writeHead(200,headers);fs.createReadStream(file).pipe(res)});
}

ensureState();setupCode();
const server=http.createServer(async(req,res)=>{
  let url;
  try{
    url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
    securityHeaders(req,res);requestLog(req,res,url);
    if(url.pathname.startsWith('/api/'))return await api(req,res,url);
    if(req.method!=='GET'&&req.method!=='HEAD')return text(res,405,'Método não permitido');
    return staticFile(req,res,url);
  }catch(err){logLine('error','request_error',{path:url?.pathname||req.url,error:String(err?.stack||err)});if(!res.headersSent)json(res,500,{ok:false,error:'Erro interno do servidor.'});else res.end();}
});
server.keepAliveTimeout=65000;server.headersTimeout=70000;server.requestTimeout=120000;
server.on('clientError',(err,socket)=>{try{socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')}catch{};logLine('warn','client_error',{error:String(err?.message||err)});});
let shuttingDown=false;
function shutdown(signal){
  if(shuttingDown)return;shuttingDown=true;logLine('info','shutdown_start',{signal});
  for(const res of [...sseClients]){try{res.end()}catch{}}sseClients.clear();
  server.close(()=>{try{db.exec('PRAGMA wal_checkpoint(TRUNCATE)')}catch{};try{db.close()}catch{};try{fs.unlinkSync(PID_PATH)}catch{};logLine('info','shutdown_complete',{signal});process.exit(0)});
  setTimeout(()=>process.exit(1),10000).unref();
}
process.on('SIGTERM',()=>shutdown('SIGTERM'));process.on('SIGINT',()=>shutdown('SIGINT'));
process.on('uncaughtException',err=>{logLine('error','uncaught_exception',{error:String(err?.stack||err)});shutdown('uncaughtException')});
process.on('unhandledRejection',err=>logLine('error','unhandled_rejection',{error:String(err?.stack||err)}));
server.listen(PORT,HOST,()=>{
  logLine('info','server_started',{version:APP_VERSION,env:NODE_ENV,host:HOST,port:PORT,database:DB_PATH,publicUrl:PUBLIC_URL||null,trustProxy:TRUST_PROXY,platform:DEPLOY_PLATFORM,environment:DEPLOY_ENV,deploymentId:DEPLOY_ID||null});
  console.log(`\nOAF Entregas ${APP_VERSION} — Backend ativo`);
  console.log(`Servidor local: http://localhost:${PORT}`);
  if(PUBLIC_URL)console.log(`Endereço público: ${PUBLIC_URL}`);
  else if(HOST==='0.0.0.0')console.log('Rede local: abra http://IP-DESTE-COMPUTADOR:'+PORT+' nos celulares.');
  if(!isSetup())console.log(`CÓDIGO DE CONFIGURAÇÃO INICIAL: ${setupCode()}`);
  if(IS_PRODUCTION&&!PUBLIC_URL)console.warn('AVISO: OAF_ENV=production sem OAF_PUBLIC_URL configurada.');
  if(IS_PRODUCTION&&COOKIE_SECURE_MODE==='auto')console.warn('AVISO: em produção, prefira OAF_COOKIE_SECURE=1 atrás de HTTPS.');
  console.log(`Banco: ${DB_PATH}\n`);
});
