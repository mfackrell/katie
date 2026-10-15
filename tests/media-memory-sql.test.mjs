import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,openSync,closeSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
test('real disposable PostgreSQL: complete corpus, roles, live ownership, deletion, versions and video recovery',()=>{
 const bin=process.env.KATIE_TEST_PG_BIN || '/usr/lib/postgresql/16/bin';
 const dir=mkdtempSync(join(tmpdir(),'katie-media-pg-'));
 const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222',c='33333333-3333-4333-8333-333333333333',current='44444444-4444-4444-8444-444444444444',id='55555555-5555-4555-8555-555555555555';
 const save=`select save_media_evidence('${a}','${c}','${id}','extracted','v1','same.txt','text/plain','partial',now(),false,repeat('irrelevant ',3000)||'neonplatypus checkout');`;
 try {
  let r=spawnSync(join(bin,'initdb'),['-D',join(dir,'data'),'-A','trust','--no-locale'],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
  const blocks=[
   `create role anon; create role authenticated; create role service_role bypassrls; create table actors(id uuid primary key); create table chats(id uuid primary key,actor_id uuid references actors); grant usage on schema public to service_role; grant select,update on chats to service_role;`,
   readFileSync('supabase/migrations/202610130001_video_analysis_jobs.sql','utf8'),
   readFileSync('supabase/migrations/20261014220000_media_memory.sql','utf8'),
   `insert into actors values('${a}'),('${b}'); insert into chats values('${c}','${a}'),('${current}','${a}'); set role service_role; ${save} ${save}`,
   `insert into media_evidence(actor_id,source_chat_id,attachment_id,kind,version,filename,mime_type,coverage,created_at,chunk_index,start_offset,body)
    select '${a}','${current}',gen_random_uuid(),'discovery','v1','newer.txt','text/plain','metadata',now(),0,0,'unrelated summary' from generate_series(1,50);
    set role service_role;`,
   `do $$ begin
    if not exists(select 1 from search_media_evidence('${a}','${current}','neonplatypus') where start_offset>=24000 and coverage='partial') then raise exception 'Late full-text detail missing'; end if;
    if not exists(select 1 from read_media_evidence('${a}','${current}','${c}','${id}','extracted','v1',30000) where body like '%neonplatypus%') then raise exception 'Offset read failed'; end if;
    if (select count(*) from media_evidence where attachment_id='${id}')<>10 then raise exception 'Duplicate chunks'; end if;
    begin perform * from search_media_evidence('${b}','${current}','neonplatypus'); raise exception 'Wrong actor accepted'; exception when raise_exception then if SQLERRM<>'Live request owner required' then raise; end if; end;
    if exists(select 1 from search_media_evidence('${a}','${current}','neonplatypus','video/%')) then raise exception 'Ignored type'; end if;
   end $$; reset role;`,
   `do $$ begin
    if has_table_privilege('anon','media_evidence','select') or has_function_privilege('authenticated','search_media_evidence(uuid,uuid,text,text,timestamptz,timestamptz)','execute') then raise exception 'Client access'; end if;
    if not (select relrowsecurity from pg_class where oid='media_evidence'::regclass) then raise exception 'RLS disabled'; end if;
   end $$;`,
   `set role anon; do $$ begin
      begin perform * from media_evidence; raise exception 'Anonymous read accepted'; exception when insufficient_privilege then null; end;
      begin perform * from search_media_evidence('${a}','${current}','checkout'); raise exception 'Anonymous RPC accepted'; exception when insufficient_privilege then null; end;
    end $$; reset role;
    set role authenticated; do $$ begin
      begin perform * from media_evidence; raise exception 'Client read accepted'; exception when insufficient_privilege then null; end;
    end $$; reset role;`,
   `insert into video_analysis_jobs(id,actor_id,chat_id,target_chat_id,attachment_path,status,analysis_text,response_delivered_at,model) values ('66666666-6666-4666-8666-666666666666','${a}','${c}','${current}','chats/${c}/${id}.source','completed','Complete original report containing ultraviolet checkout zebra.',now(),'Qwen/full-original-model-version');
    set role service_role; select reconcile_media_video('${a}','${current}'); select reconcile_media_video('${a}','${current}');
    do $$ begin if not exists(select 1 from media_evidence where body='Complete original report containing ultraviolet checkout zebra.' and version like '%Qwen/full-original-model-version:%') then raise exception 'Delivered job not recovered'; end if; end $$; reset role;`,
   `update video_analysis_jobs set analysis_text='Late completed Qwen report preserves cerulean checkout detail.',fallback_state='completed',fallback_text='Grok sampled report repeating Qwen checkout with limited coverage.',fallback_model='grok/full-original-model-version' where id='66666666-6666-4666-8666-666666666666';
    do $$ begin
     if not exists(select 1 from media_evidence where body='Late completed Qwen report preserves cerulean checkout detail.' and version like '%Qwen/full-original-model-version:%') then raise exception 'Changed late report not indexed'; end if;
     if not exists(select 1 from media_evidence where body='Grok sampled report repeating Qwen checkout with limited coverage.' and coverage like '%not independent confirmation%' and version like '%grok/full-original-model-version:%') then raise exception 'Grok provenance missing'; end if;
    end $$;`,
   `update chats set actor_id='${b}' where id='${c}'; do $$ begin if exists(select 1 from search_media_evidence('${a}','${current}','neonplatypus')) then raise exception 'Stale actor leaked'; end if; end $$; update chats set actor_id='${a}' where id='${c}'; delete from chats where id='${c}';`,
   `do $$ begin
    if exists(select 1 from search_media_evidence('${a}','${current}','neonplatypus')) then raise exception 'Deleted source leaked'; end if;
    begin ${save} raise exception 'Deleted source recreated'; exception when raise_exception then if SQLERRM<>'Live source owner required' then raise; end if; end;
   end $$; select 'MEDIA_MEMORY_SQL_OK';`
  ];
  writeFileSync(join(dir,'verify.sql'),blocks.map(b=>b.replace(/\n\s*\n/g,'\n').trim()).join('\n\n')+'\n\n');
  const fd=openSync(join(dir,'verify.sql'),'r');
  try {r=spawnSync(join(bin,'postgres'),['--single','-j','-D',join(dir,'data'),'postgres'],{stdio:[fd,'pipe','pipe'],encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});} finally {closeSync(fd);}
  assert.equal(r.status,0,r.stderr); assert.doesNotMatch(r.stderr,/ERROR|FATAL|PANIC/); assert.match(r.stdout,/MEDIA_MEMORY_SQL_OK/);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
