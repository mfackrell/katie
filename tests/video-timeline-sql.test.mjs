import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import pg from 'pg';

test('timeline real private PostgreSQL: ownership, roles, atomic claims, validation, deletion and late completion', {timeout:180000},async t=>{
 const bin=process.env.KATIE_TEST_PG_BIN || '/usr/lib/postgresql/16/bin';
 const root=mkdtempSync(join(tmpdir(),'katie-timeline-pg-')),data=join(root,'data');
 const clients=new Set();let started=false;
 const run=(name,args)=>{const r=spawnSync(join(bin,name),args,{encoding:'utf8',timeout:30000});assert.equal(r.status,0,`${r.stderr}\n${name==='pg_ctl' ? readFileSync(join(root,'server.log'),'utf8') : ''}`);};
 const connect=async()=>{const c=new pg.Client({host:root,port:55433,database:'postgres',user:'postgres',password:'',ssl:false,connectionTimeoutMillis:5000});await c.connect();clients.add(c);return c;};
 try {
  run('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);
  run('pg_ctl',['-D',data,'-l',join(root,'server.log'),'-o',`-h '' -k ${root} -p 55433`,'-w','start']);started=true;
  const db=await connect();
  await db.query('create role anon; create role authenticated; create role service_role bypassrls; create table actors(id uuid primary key); create table chats(id uuid primary key,actor_id uuid references actors); grant usage on schema public to service_role; grant select,update on chats to service_role;');
  for(const name of ['202610130001_video_analysis_jobs.sql','20261014220000_media_memory.sql','20261015180000_video_timelines.sql'])await db.query(readFileSync(`supabase/migrations/${name}`,'utf8'));
  const actor=randomUUID(),other=randomUUID(),current=randomUUID(),source=randomUUID(),attachment=randomUUID(),fingerprint='a'.repeat(64),version='visual-sampled-v1';
  await db.query('insert into actors values($1),($2)',[actor,other]);
  await db.query('insert into chats values($1,$3),($2,$3)',[current,source,actor]);
  const identity=[actor,current,source,attachment,fingerprint,version];
  const claim=(c,receipt=randomUUID(),start=0,end=30)=>c.query('select claim_video_timeline($1,$2,$3,$4,$5,$6,$7,$8,60,$9) as claimed',[...identity,start,end,receipt]);
  const receipt=randomUUID();
  await t.test('RLS and actual client permissions',async()=>{
   assert.equal((await db.query("select relrowsecurity from pg_class where oid='video_timeline_windows'::regclass")).rows[0].relrowsecurity,true);
   for(const role of ['anon','authenticated']){
    await db.query(`set role ${role}`);
    await assert.rejects(claim(db),/permission denied/);
    await assert.rejects(db.query('select * from video_timeline_windows'),/permission denied/);
    await db.query('reset role');
   }
   await db.query('set role service_role');
   await assert.rejects(db.query('select * from read_video_timeline($1,$2,$3,$4,$5,$6)',[other,...identity.slice(1)]),/Live request owner/);
  });
  await t.test('concurrent requests create one durable receipt and cannot reclaim expired/ambiguous work',async()=>{
   const c=await connect();await c.query('set role service_role');
   const results=await Promise.all([claim(db,receipt),claim(c)]);
   assert.equal(results.filter(r=>r.rows[0].claimed).length,1);
   // Capture winner without relying on racing session scheduling.
   const winner=(await db.query('select receipt from video_timeline_windows')).rows[0].receipt;
   await db.query("update video_timeline_windows set lease_until=now()-interval '1 day'");
   assert.equal((await claim(db)).rows[0].claimed,false);
   assert.equal((await db.query('select attempts from video_timeline_windows')).rows[0].attempts,1);
   assert.equal(typeof winner,'string');
  });
  const frames=[{id:'f0',seconds:0,sha256:'a'.repeat(64)},{id:'f1',seconds:29,sha256:'b'.repeat(64)}];
  const events=[{description:'error appears on screen',frame_ids:['f1'],observed_start:29,observed_end:29}];
  const finish=async(c,items=events)=>{
   const winner=(await db.query('select receipt from video_timeline_windows limit 1')).rows[0]?.receipt ?? receipt;
   return c.query('select finish_video_timeline($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,false,null,$12) as saved',[...identity,winner,'configured-model',JSON.stringify(frames),JSON.stringify(items),'structured original report','same.mp4']);
  };
  await t.test('publication rejects foreign evidence and invented numeric times; complete cache reuses without replacement',async()=>{
   await assert.rejects(finish(db,[{...events[0],frame_ids:['foreign']}]),/Foreign frame/);
   await assert.rejects(finish(db,[{...events[0],observed_start:2}]),/Invented event times/);
   assert.equal((await finish(db)).rows[0].saved,true);
   assert.equal((await finish(db)).rows[0].saved,false);
   assert.equal((await claim(db)).rows[0].claimed,false);
   const numeric=await db.query('select * from search_video_timeline_events($1,$2,$3,$4,$5,$6,20,25,$7,0)',[...identity,'']);
   assert.equal(numeric.rows.length,0);
   const ending=await db.query('select * from search_video_timeline_events($1,$2,$3,$4,$5,$6,29,30,$7,0)',[...identity,'error']);
   assert.equal(ending.rows[0].observed_start,29);
   const indexed=await db.query('select * from search_media_evidence($1,$2,$3)',[actor,current,'error']);
   assert.equal(indexed.rows[0].attachment_id,attachment);
   assert.equal((await db.query('select * from read_video_timeline($1,$2,$3,$4,$5,$6)',identity)).rows.length,1);
   assert.equal((await db.query('select * from read_video_timeline($1,$2,$3,$4,$5,$6)',[...identity.slice(0,4),'b'.repeat(64),version])).rows.length,0);
  });
  await t.test('bounded first occurrence selects earliest positive matching sample, not enclosing event time',async()=>{
   const laterReceipt=randomUUID();
   assert.equal((await claim(db,laterReceipt,30,60)).rows[0].claimed,true);
   const samples=[{id:'before',seconds:31,sha256:'c'.repeat(64)},{id:'match',seconds:40,sha256:'d'.repeat(64)},{id:'outside',seconds:55,sha256:'e'.repeat(64)}];
   const observations=[{description:'error visible later',frame_ids:['before','match','outside'],observed_start:31,observed_end:55},{description:'unrelated scene',frame_ids:['before'],observed_start:31,observed_end:31}];
   await db.query('select finish_video_timeline($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,null,$12)',[...identity,laterReceipt,'configured-model',JSON.stringify(samples),JSON.stringify(observations),'structured original report','same.mp4']);
   const result=await db.query('select * from search_video_timeline_events($1,$2,$3,$4,$5,$6,20,45,$7,0)',[...identity,'error']);
   assert.deepEqual(result.rows.map(r=>({description:r.description,start:r.observed_start,end:r.observed_end,ids:r.frame_ids})),[
    {description:'error appears on screen',start:29,end:29,ids:['f1']},
    {description:'error visible later',start:31,end:40,ids:['before','match']},
   ]);
   const clipped=await db.query('select * from search_video_timeline_events($1,$2,$3,$4,$5,$6,35,45,$7,0)',[...identity,'error']);
   assert.equal(clipped.rows[0].observed_start,40);
   assert.deepEqual(clipped.rows[0].frame_ids,['match']);
  });
  await t.test('source deletion waits for active owner lock then cascades; late completion never resurrects',async()=>{
   const writer=await connect(),deleter=await connect();
   await writer.query('begin');await writer.query('set local role service_role');
   await claim(writer,randomUUID(),30,60);
   let deleted=false;const deletion=deleter.query('delete from chats where id=$1',[source]).then(()=>{deleted=true;});
   const deadline=Date.now()+5000;
   while(Date.now()<deadline){const wait=await db.query('select $2::integer=any(pg_blocking_pids($1)) as blocked',[deleter.processID,writer.processID]);if(wait.rows[0].blocked)break;await new Promise(r=>setTimeout(r,10));}
   assert.equal(deleted,false);await writer.query('commit');await deletion;
   assert.equal((await db.query('select count(*)::int n from video_timeline_windows')).rows[0].n,0);
   await assert.rejects(finish(db),/Live source owner/);
   await assert.rejects(claim(db),/Live source owner/);
  });
 } finally {
  for(const c of clients)await c.end().catch(()=>{});
  if(started)spawnSync(join(bin,'pg_ctl'),['-D',data,'-m','immediate','-w','stop'],{timeout:10000});
  rmSync(root,{recursive:true,force:true});
 }
});
