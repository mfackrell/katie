import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync,openSync,closeSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

// Additional real SQL coverage without sockets. The multi-session test remains mandatory and separate.
test('real standalone PostgreSQL validates management RPCs, immutable snapshots, admission and ACLs',{timeout:60000},()=>{
 const bin=process.env.KATIE_TEST_PG_BIN||'/usr/lib/postgresql/16/bin';
 const root=mkdtempSync(join(tmpdir(),'katie-agent-standalone-')),data=join(root,'data');
 try{
  const init=spawnSync(join(bin,'initdb'),['-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8'],{encoding:'utf8',timeout:30000});assert.equal(init.status,0,init.stderr);
  const setup=`create role anon;create role authenticated;create role service_role bypassrls;create table actors(id uuid primary key,name text,system_prompt text,review_mode text);create table chats(id uuid primary key,actor_id uuid references actors,title text,created_at timestamptz,updated_at timestamptz);create table repo_sync_runs(id uuid primary key,repository_full_name text);grant usage on schema public to service_role;grant select,insert,update on actors,chats,repo_sync_runs to service_role;`;
  const migration=readFileSync('supabase/migrations/20261016211426_agent_management.sql','utf8').split('\n').filter(l=>!l.trimStart().startsWith('--')).join(' ');
  const checks=`do $test$
  declare cfg jsonb:='{"name":"Writer","instructions":"Original","research":false,"attachments":false,"development":true,"reviewMode":"always","maxActiveTasks":1,"maxInputChars":1000}'; a jsonb;t jsonb;other jsonb; tid uuid:=gen_random_uuid(); rid uuid:=gen_random_uuid();
  begin
   assert not has_table_privilege('anon','managed_agents','SELECT');
   assert not has_table_privilege('authenticated','agent_tasks','INSERT');
   assert not has_function_privilege('anon','check_agent_chat(uuid,uuid,text)','EXECUTE');
   assert not has_function_privilege('authenticated','claim_agent_dispatch(uuid)','EXECUTE');
   a:=save_managed_agent(null,cfg,false);
   t:=create_agent_task(tid,(a->>'id')::uuid,'Saved input','general',null);
   perform save_managed_agent((a->>'id')::uuid,cfg||'{"instructions":"Changed","research":true}'::jsonb,false);
   assert (select snapshot from agent_tasks where id=tid)=cfg;
   perform transition_agent_task(tid,'start',null);
   assert claim_agent_execution(tid,t->>'request_id');
   assert not claim_agent_execution(tid,t->>'request_id');
   assert (check_agent_chat((a->>'actor_id')::uuid,(t->>'chat_id')::uuid,t->>'request_id')->'snapshot')=cfg;
   other:=create_agent_task(gen_random_uuid(),(a->>'id')::uuid,'Second','general',null);
   begin perform transition_agent_task((other->>'id')::uuid,'start',null);raise exception 'unexpected admission';exception when others then if sqlerrm not like '%Active task limit%' then raise;end if;end;
   begin perform check_agent_chat((a->>'actor_id')::uuid,(other->>'chat_id')::uuid,t->>'request_id');raise exception 'unexpected cross-chat';exception when others then if sqlerrm not like '%admitted%' then raise;end if;end;
   perform save_managed_agent((a->>'id')::uuid,cfg,true);
   begin perform create_agent_task(gen_random_uuid(),(a->>'id')::uuid,'Archived','general',null);raise exception 'unexpected archived creation';exception when others then if sqlerrm not like '%archived%' then raise;end if;end;
   begin delete from chats where id=(t->>'chat_id')::uuid;raise exception 'unexpected history deletion';exception when foreign_key_violation then null;end;
   begin update chats set actor_id=(select (save_managed_agent(null,cfg,false)->>'actor_id')::uuid) where id=(t->>'chat_id')::uuid;raise exception 'unexpected actor rebind';exception when foreign_key_violation then null;end;
   begin update managed_agents set config=cfg||'{"reviewMode":null}'::jsonb where id=(a->>'id')::uuid;raise exception 'unexpected invalid config';exception when check_violation then null;end;
   a:=save_managed_agent(null,cfg,false);insert into repo_sync_runs values(rid,'owner/repo');t:=create_agent_task(gen_random_uuid(),(a->>'id')::uuid,'Develop','development',rid);
   perform transition_agent_task((t->>'id')::uuid,'start',null);assert claim_agent_dispatch((t->>'id')::uuid);assert not claim_agent_dispatch((t->>'id')::uuid);
  end $test$;`.replace(/\n/g,' ');
  const input=join(root,'input.sql');writeFileSync(input,[setup,migration,checks].join('\n')+'\n');
  const fd=openSync(input,'r');
  const result=spawnSync(join(bin,'postgres'),['--single','-D',data,'postgres'],{stdio:[fd,'pipe','pipe'],encoding:'utf8',timeout:30000,maxBuffer:1024*1024});closeSync(fd);
  assert.equal(result.status,0,JSON.stringify({error:result.error?.message,signal:result.signal,stdout:result.stdout,stderr:result.stderr}));assert.doesNotMatch(result.stderr,/ERROR:|FATAL:|PANIC:/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
