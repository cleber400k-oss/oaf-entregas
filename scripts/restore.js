'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const root=path.resolve(__dirname,'..');
const dataDir=process.env.OAF_DATA_DIR?path.resolve(process.env.OAF_DATA_DIR):path.join(root,'data');
const dbPath=path.join(dataDir,'oaf-entregas.sqlite');
const pidPath=path.join(dataDir,'server.pid');
const file=process.argv[2]&&path.resolve(process.argv[2]);
const yes=process.argv.includes('--yes');
if(!file||!yes){console.error('Uso: node scripts/restore.js /caminho/backup.sqlite --yes');process.exit(2)}
if(!fs.existsSync(file)){console.error('Backup não encontrado.');process.exit(2)}
if(fs.existsSync(pidPath)){
  const pid=Number(fs.readFileSync(pidPath,'utf8').trim());
  if(pid){try{process.kill(pid,0);console.error(`Servidor parece ativo (PID ${pid}). Pare o serviço antes de restaurar.`);process.exit(3)}catch{}}
}
const verify=new DatabaseSync(file,{readOnly:true});try{const row=verify.prepare('PRAGMA integrity_check').get();if(String(row.integrity_check||row['integrity_check'])!=='ok')throw new Error('Backup inválido.')}finally{verify.close()}
fs.mkdirSync(dataDir,{recursive:true});
if(fs.existsSync(dbPath)){const safe=dbPath+`.pre-restore-${new Date().toISOString().replace(/[:.]/g,'-')}`;fs.copyFileSync(dbPath,safe);console.log('Cópia de segurança atual:',safe)}
for(const suffix of ['-wal','-shm'])try{fs.unlinkSync(dbPath+suffix)}catch{}
fs.copyFileSync(file,dbPath);console.log('Restauração concluída:',dbPath);
