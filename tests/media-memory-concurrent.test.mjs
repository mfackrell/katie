import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import * as crypto from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import pg from 'pg';

// Always a fresh private Unix-socket cluster. DATABASE_URL and production credentials are never used.
test('real multi-session PostgreSQL: resumable full evidence and deletion/completion races', {timeout:180000}, async t=>{
 const bin=process.env.KATIE_TEST_PG_BIN || '/usr/lib/postgresql/16/bin';
 const root=mkdtempSync(join(tmpdir(),'katie-media-concurrent-')), data=join(root,'data');
 const clients=new Set(); let started=false;
 const run=(name,args)=>{const r=spawnSync(join(bin,name),args,{encoding:'utf8',timeout:30000});assert.equal(r.status,0,r.stderr || r.error?.message);return r;};
 const connect=async()=>{const c=new pg.Client({host:root,port:55432,database:'postgres',user:'postgres',password:'',ssl:false,connectionTimeoutMillis:5000});await c.connect();clients.add(c);return c;};
 const stopClient=async c=>{clients.delete(c);await c.end();};
 try {
  run('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);
  run('pg_ctl',['-D',data,'-l',join(root,'server.log'),'-o',`-h '' -k ${root} -p 55432`,'-w','start']);started=true;
  const db=await connect();
  await db.query('create role anon; create role authenticated; create role service_role bypassrls; create table actors(id uuid primary key); create table chats(id uuid primary key,actor_id uuid references actors); grant usage on schema public to service_role; grant select,update on chats to service_role;');
  for(const file of ['202610130001_video_analysis_jobs.sql','20261014220000_media_memory.sql','20261015142626_media_memory_incremental.sql'])await db.query(readFileSync(`supabase/migrations/${file}`,'utf8'));
  const actor=randomUUID(), other=randomUUID(), current=randomUUID();
  await db.query('insert into actors values($1),($2);',[actor,other]);
  await db.query('insert into chats values($1,$2)',[current,actor]);
  const source=async()=>{const id=randomUUID();await db.query('insert into chats values($1,$2)',[id,actor]);return id;};
  const save=async(c,chat,id,text='Saved discovery evidence',mime='text/plain')=>c.query("select save_media_evidence($1,$2,$3,'discovery','v1','same.txt',$4,'partial',now(),false,$5)",[actor,chat,id,mime,text]);
  const blocked=async(pid,blocker)=>{
   const until=Date.now()+5000;
   do {const r=await db.query('select $2::integer=any(pg_blocking_pids($1)) as blocked',[pid,blocker]);if(r.rows[0].blocked)return;await new Promise(resolve=>setTimeout(resolve,10));}while(Date.now()<until);
   assert.fail('Expected overlapping transactions to reach a real PostgreSQL lock wait');
  };
  await t.test('least privilege denies actual client table and RPC access',async()=>{
   const c=await connect();
   for(const role of ['anon','authenticated']){
    await c.query(`set role ${role}`);
    await assert.rejects(c.query('select * from media_evidence_ingestion'),/permission denied/);
    await assert.rejects(c.query('select begin_media_evidence_ingestion($1,$2,$3,$4,$5,$6,$7)',[actor,current,randomUUID(),'extracted','v1','hash',10]),/permission denied/);
    await c.query('reset role');
   }
   assert.equal((await db.query("select relrowsecurity from pg_class where oid='media_evidence_ingestion'::regclass")).rows[0].relrowsecurity,true);
   await stopClient(c);
  });
  await t.test('actual TypeScript indexer resumes >10M Unicode characters through real SQL after a lost acknowledgment and restart',async()=>{
   const chat=await source(), attachment=randomUUID();
   const text='alpha '.repeat(38400)+'😀 marker '+'alpha '.repeat(1661600)+' finaltailplatypus';
   assert.ok(text.length>10000000);
   const file={id:attachment,actorId:actor,chatId:chat,fileName:'same.txt',mimeType:'text/plain',observedSummary:'Short unrelated description',summaryCoverage:'partial',createdAt:'2026-10-01T00:00:00Z'};
   let connection=await connect();await connection.query('set role service_role');
   let calls=0, maxText=0, loseAck=true;
   const build=()=>{
    const exports={};
    const admin={getSupabaseAdminClient:()=>({rpc:async(name,args)=>{
     assert.ok(['save_media_evidence','begin_media_evidence_ingestion','append_media_evidence_batch'].includes(name));
     calls++;maxText=Math.max(maxText,args.p_text?.length ?? 0);
     const keys=Object.keys(args);const sql=`select public.${name}(${keys.map((k,i)=>`${k}=>$${i+1}`).join(',')}) as data`;
     try {const result=await connection.query(sql,Object.values(args));if(name==='append_media_evidence_batch' && loseAck){loseAck=false;return {data:null,error:{message:'offline lost acknowledgment'}};}return {data:result.rows[0].data,error:null};}
     catch(error){return {data:null,error:{message:error.message}};}
    }})};
    vm.runInNewContext(ts.transpileModule(readFileSync('lib/media-memory/evidence.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:name=>name==='node:crypto'?crypto:admin,Date,console,Set,Map});return exports;
   };
   let indexer=build();const reference={extractedText:text,extractionCoverage:'partial'};
   await assert.rejects(indexer.indexReference(file,reference),/indexing unavailable/);
   assert.ok((await db.query('select next_offset from media_evidence_ingestion where attachment_id=$1',[attachment])).rows[0].next_offset>0);
   await stopClient(connection);connection=await connect();await connection.query('set role service_role');indexer=build();
   let progress={complete:false,nextPart:0}, iterations=0;
   while(!progress.complete && iterations++<100){const before=calls;progress=await indexer.indexReference(file,reference,progress.nextPart);assert.ok(calls-before<=8,'bounded RPC work per invocation');}
   assert.equal(progress.complete,true);assert.ok(iterations>2);assert.ok(maxText<=230801,'bounded Unicode-safe transport');
   const state=(await db.query('select * from media_evidence_ingestion where attachment_id=$1',[attachment])).rows[0];
   assert.equal(state.next_offset,state.total_characters);
   const rebuilt=(await db.query("select md5(string_agg(substring(body from 1 for least(3600,$2-start_offset)),'' order by start_offset)) as digest from media_evidence where attachment_id=$1 and kind='extracted'",[attachment,state.total_characters])).rows[0].digest;
   assert.equal(rebuilt,createHash('md5').update(text).digest('hex'),'every canonical character preserved');
   const hits=await db.query('select * from search_media_evidence($1,$2,$3)',[actor,current,'finaltailplatypus']);
   assert.ok(hits.rows.some(hit=>hit.start_offset>10000000 && hit.attachment_id===attachment));
   assert.match(state.version,/^text-v1:sha256:/);
   const further=await db.query('select * from read_media_evidence($1,$2,$3,$4,$5,$6,$7)',[actor,current,chat,attachment,'extracted',state.version,state.total_characters-30]);
   assert.ok(further.rows.some(hit=>hit.body.includes('finaltailplatypus')));
   const count=(await db.query('select count(*)::int n from media_evidence where attachment_id=$1',[attachment])).rows[0].n;
   assert.equal(await indexer.indexEvidence(file,'extracted','text-v1',text,'partial'),true);
   assert.equal((await db.query('select count(*)::int n from media_evidence where attachment_id=$1',[attachment])).rows[0].n,count);
   await assert.rejects(db.query('select begin_media_evidence_ingestion($1,$2,$3,$4,$5,$6,$7)',[other,chat,attachment,'extracted',state.version,state.content_hash,state.total_characters]),/Live source owner required/);
   await stopClient(connection);
  });
  await t.test('deletion waits for in-flight indexing, then removes both evidence and durable progress',async()=>{
   for(let repeat=0;repeat<3;repeat++){
    const chat=await source(),id=randomUUID(),writer=await connect(),deleter=await connect();
    await writer.query('begin');
    await writer.query('select begin_media_evidence_ingestion($1,$2,$3,$4,$5,$6,$7)',[actor,chat,id,'extracted','race','hash',500000]);
    await save(writer,chat,id);
    const deletion=deleter.query('delete from chats where id=$1',[chat]);
    await blocked(deleter.processID,writer.processID);await writer.query('commit');await deletion;
    assert.equal((await db.query('select count(*)::int n from media_evidence where source_chat_id=$1',[chat])).rows[0].n,0);
    assert.equal((await db.query('select count(*)::int n from media_evidence_ingestion where source_chat_id=$1',[chat])).rows[0].n,0);
    await assert.rejects(save(writer,chat,id),/Live source owner required/);
    await stopClient(writer);await stopClient(deleter);
   }
  });
  await t.test('indexing waiting behind a deletion cannot resurrect the deleted source',async()=>{
   const chat=await source(),id=randomUUID(),writer=await connect(),deleter=await connect();
   await deleter.query('begin');await deleter.query('delete from chats where id=$1',[chat]);
   const indexing=save(writer,chat,id).then(()=>({success:true}),error=>({error}));
   await blocked(writer.processID,deleter.processID);await deleter.query('commit');
   assert.match((await indexing).error?.message ?? '',/Live source owner required/);
   assert.equal((await db.query('select count(*)::int n from media_evidence where source_chat_id=$1',[chat])).rows[0].n,0);
   await stopClient(writer);await stopClient(deleter);
  });
  await t.test('delayed completion racing deletion leaves an orphan operational row but no searchable evidence',async()=>{
   const chat=await source(),id=randomUUID(),job=randomUUID(),updater=await connect(),deleter=await connect();
   await save(db,chat,id,'Registered recording','video/mp4');
   await db.query("insert into video_analysis_jobs(id,actor_id,chat_id,target_chat_id,attachment_path,status,model) values($1,$2,$3,$4,$5,'queued','Qwen/original-model')",[job,actor,chat,current,`chats/${chat}/${id}.source`]);
   await deleter.query('begin');await deleter.query('delete from chats where id=$1',[chat]);
   const completion=updater.query("update video_analysis_jobs set status='completed',analysis_text='A delayed saved report with distinctive latecallbackzebra detail.',response_delivered_at=now() where id=$1",[job]);
   await blocked(updater.processID,deleter.processID);await deleter.query('commit');await completion;
   await db.query('select reconcile_media_video($1,$2)',[actor,current]);
   assert.equal((await db.query('select chat_id from video_analysis_jobs where id=$1',[job])).rows[0].chat_id,null);
   assert.equal((await db.query('select count(*)::int n from media_evidence where attachment_id=$1',[id])).rows[0].n,0);
   await stopClient(updater);await stopClient(deleter);
  });
  await t.test('already-delivered large Qwen and saved Grok reports finish incrementally without changing original reports',async()=>{
   const chat=await source(),id=randomUUID(),job=randomUUID();await save(db,chat,id,'Registered recording','video/mp4');
   const text='reported '.repeat(27000)+' videotailplatypus';
   await db.query("insert into video_analysis_jobs(id,actor_id,chat_id,target_chat_id,attachment_path,status,analysis_text,response_delivered_at,model,fallback_state,fallback_text,fallback_model) values($1,$2,$3,$4,$5,'completed',$6,now(),'Qwen/full-original-model-version','completed','Grok sampled report repeats the supplied Qwen report.','Grok/full-original-model-version')",[job,actor,chat,current,`chats/${chat}/${id}.source`,text]);
   assert.ok(text.length>230800 && text.length<=250000, 'Preserve the existing operational report cap');
   assert.ok((await db.query('select next_offset from media_evidence_ingestion where attachment_id=$1',[id])).rows[0].next_offset<text.length);
   let remaining=1,iterations=0;
   while(remaining && iterations++<60){await db.query('select reconcile_media_video($1,$2)',[actor,current]);remaining=(await db.query('select count(*)::int n from media_evidence_ingestion where attachment_id=$1 and next_offset<total_characters',[id])).rows[0].n;}
   assert.equal(remaining,0);assert.ok(iterations>=1);
   const hits=await db.query('select * from search_media_evidence($1,$2,$3)',[actor,current,'videotailplatypus']);
   assert.ok(hits.rows.some(hit=>hit.attachment_id===id && hit.start_offset>230000 && hit.version.includes('Qwen/full-original-model-version')));
   assert.equal((await db.query('select md5(analysis_text) digest from video_analysis_jobs where id=$1',[job])).rows[0].digest,createHash('md5').update(text).digest('hex'));
   assert.ok((await db.query("select coverage from media_evidence where attachment_id=$1 and version like '%Grok/full-original-model-version%'",[id])).rows.every(row=>row.coverage.includes('not independent confirmation')));
  });
 } finally {
  await Promise.allSettled([...clients].map(c=>c.end()));
  if(started)run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);
  rmSync(root,{recursive:true,force:true});
 }
});
