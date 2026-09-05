'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync,backup}=require('node:sqlite');

const root=path.resolve(__dirname,'..');
const dataDir=process.env.OAF_DATA_DIR?path.resolve(process.env.OAF_DATA_DIR):path.join(root,'data');
const backupDir=process.env.OAF_BACKUP_DIR?path.resolve(process.env.OAF_BACKUP_DIR):path.join(root,'backups');
const dbPath=path.join(dataDir,'oaf-entregas.sqlite');
const retention=Math.max(1,Number(process.env.OAF_BACKUP_RETENTION_DAYS||30));
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const out=path.join(backupDir,`oaf-entregas-${stamp}.sqlite`);

async function main(){
  if(!fs.existsSync(dbPath))throw new Error(`Banco não encontrado: ${dbPath}`);
  fs.mkdirSync(backupDir,{recursive:true});
  const db=new DatabaseSync(dbPath,{readOnly:true});
  try{await backup(db,out)}finally{db.close()}
  const verify=new DatabaseSync(out,{readOnly:true});
  try{const row=verify.prepare('PRAGMA integrity_check').get();if(String(row.integrity_check||row['integrity_check'])!=='ok')throw new Error('Falha no integrity_check do backup.')}finally{verify.close()}
  for(const suffix of ['-wal','-shm'])try{fs.unlinkSync(out+suffix)}catch{}
  const cutoff=Date.now()-retention*86400000;
  for(const name of fs.readdirSync(backupDir)){
    if(!/^oaf-entregas-.*\.sqlite$/.test(name))continue;
    const file=path.join(backupDir,name);try{if(fs.statSync(file).mtimeMs<cutoff&&file!==out)fs.unlinkSync(file)}catch{}
  }
  console.log(`Backup OK: ${out}`);
}
main().catch(err=>{console.error(err.stack||err);process.exit(1)});
