import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, openSync, closeSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';

test('reviewer evidence is task-bound, independent, aggregate-only and service scoped', {timeout:120000}, async()=>{
 const bin=process.env.KATIE_TEST_PG_BIN||['/usr/lib/postgresql/18/bin','/usr/lib/postgresql/17/bin','/usr/lib/postgresql/16/bin'].find(p=>existsSync(join(p,'initdb')));
 assert.ok(bin,'Native PostgreSQL required');
 const dir=mkdtempSync(join(tmpdir(),'routing-reviewer-'));const data=join(dir,'data');
 const statements=[];
 const quote=value=>value===null?'null':"'"+String(value).replaceAll("'","''")+"'";
 // Single-user PostgreSQL runs the real engine without requiring sandbox sockets.
 // SET ROLE below still exercises the function's actual execute ACLs.
 const db={query:async(sql,args=[])=>{statements.push(sql.replace(/\$(\d+)/g,(_,i)=>quote(args[Number(i)-1])));}};
 const scalar="standalone_routing_reviewer_evidence(";
 const check=(condition,message)=>statements.push(`do $$ begin if (${condition}) is not true then raise exception '${message}'; end if; end $$`);
 try {
  const init=spawnSync(join(bin,'initdb'),['-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8'],{encoding:'utf8',timeout:30000});
  assert.equal(init.status,0,init.stderr);
  await db.query(readFileSync(new URL('./sql/standalone-accounting-schema.sql',import.meta.url),'utf8'));
  await db.query(readFileSync(new URL('../supabase/migrations/20261028193000_standalone_provider_attempt_ledger.sql',import.meta.url),'utf8'));
  await db.query('create table chat_requests(request_id text primary key,actor_id text,chat_id text,review_audit jsonb)');
  await db.query(readFileSync(new URL('../supabase/migrations/20261117160000_routing_reviewer_evidence.sql',import.meta.url),'utf8'));
  const owner=randomUUID(),actor=randomUUID(),chat=randomUUID(),otherActor=randomUUID(),otherChat=randomUUID();
  await db.query("insert into actors values($1,'actor','standard'),($2,'other','standard')",[actor,otherActor]);
  await db.query('insert into chats(id,actor_id) values($1,$2),($3,$4)',[chat,actor,otherChat,otherActor]);
  await db.query('insert into standalone_owner_bindings(owner_id,actor_id,chat_id) values($1,$2,$3),($1,$4,$5)',[owner,actor,chat,otherActor,otherChat]);
  const rpc=(scope=[owner,actor,chat],intent='rewrite')=>scalar+[...scope,'current',intent].map(quote).join(',')+')';
  const hash='a'.repeat(64);
  const audit={mode:'always',verdict:'approve',reviewer:{provider:'anthropic',modelId:'independent-private-identity'},independentAssessment:{objective:'SECRET ASSESSMENT'},draft:'SECRET ANSWER',findings:'SECRET FINDINGS',finalHash:hash,reviews:[{answerHash:hash,review:{verdict:'approve'}}]};
  let n=0;
  async function add({a=actor,c=chat,ra=a,rc=c,intent='rewrite',review=audit,age='1 day',checkpoint=true}={}){
   const request='request-'+n++;
   await db.query("insert into standalone_workflows(owner_id,actor_id,chat_id,request_id,request_hash,request_body,status,checkpoints,updated_at) values($1,$2,$3,$4,$5,'{}','completed',$6,now()-$7::interval)",[owner,a,c,request,hash,JSON.stringify(checkpoint?{'routing-delivery-audit:v1':{provider:'openai',model:'gpt-4o-mini',classifiedIntent:intent,status:'unverified'}}:{}),age]);
   await db.query('insert into chat_requests values($1,$2,$3,$4)',[request,ra,rc,JSON.stringify(review)]);
  }
  await add();await add({review:{...audit,verdict:'revise',reviews:[{answerHash:hash,review:{verdict:'revise'}}]}});
  await add({a:otherActor,c:otherChat});await add({ra:otherActor});await add({rc:otherChat});
  await add({intent:'code-generation'});await add({checkpoint:false});await add({intent:null});
  await add({review:{...audit,reviewer:{provider:'openai',modelId:'gpt-4o-mini'}}});
  await add({review:{...audit,independentAssessment:null}});
  await add({review:{...audit,finalHash:'b'.repeat(64)}});await add({age:'31 days'});await add({age:'-1 day'});
  check(`(${rpc()}->'observations'->0->>'sample_count')::int=2`,'only two qualified reviews');
  check(`jsonb_array_length(${rpc()}->'observations')=1`,'one aggregate');
  check(`(${rpc()}->'observations'->0->>'approvals')::int=1 and (${rpc()}->'observations'->0->>'revisions')::int=1`,'both verdicts');
  check(`${rpc()}::text !~ 'SECRET|private-identity|request-'`,'no raw content or identity');
  for(const intent of ['unmatched',null])check(`${rpc(undefined,intent)}->'observations'='[]'::jsonb`,'unknown unmatched task');
  for(const scope of [[randomUUID(),actor,chat],[owner,otherActor,chat],[owner,actor,otherChat]]){
   statements.push(`do $$ begin begin perform ${rpc(scope)}; raise exception 'isolation failed'; exception when raise_exception then if sqlerrm<>'STANDALONE_SCOPE_DENIED' then raise; end if; end; end $$`);
  }
  for(const role of ['anon','authenticated']){
   statements.push(`do $$ begin set local role ${role}; begin perform ${rpc()}; raise exception 'execute denial failed'; exception when insufficient_privilege then null; end; reset role; end $$`);
  }
  statements.push('set role service_role');
  check(`(${rpc()}->'observations'->0->>'sample_count')::int=2`,'service role allowed');
  statements.push('reset role');
  for(let i=0;i<105;i++)await add();
  check(`(${rpc()}->'observations'->0->>'sample_count')::int=100`,'bounded recent corpus');
  const sql=statements.map(s=>s.replace(/--[^\n]*/g,'').replace(/\n/g,' ')).join('; ')+';\n';
  const input=join(dir,'regression.sql');writeFileSync(input,sql);
  const fd=openSync(input,'r');
  const result=spawnSync(join(bin,'postgres'),['--single','-D',data,'postgres'],{stdio:[fd,'pipe','pipe'],encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
  closeSync(fd);
  assert.equal(result.status,0,JSON.stringify({stderr:result.stderr,stdout:result.stdout?.slice(-4000),error:result.error?.message,signal:result.signal}));
  assert.doesNotMatch(result.stderr,/ERROR:|FATAL:/,result.stderr);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
