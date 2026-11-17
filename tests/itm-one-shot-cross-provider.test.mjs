import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {spawnSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import pg from "pg";

const source=readFileSync("lib/memory/summarizer.ts","utf8");
const migration=readFileSync("supabase/migrations/20261116194000_itm_stage2_one_shot_grant.sql","utf8");

test("one-shot recovery never calls Claude before source-bound Grok validation and irreversible claim",()=>{
  const helper=source.slice(source.indexOf("async function recoverOwnerApprovedCrossProviderStages("),
    source.indexOf("export async function maybeUpdateSummary("));
  assert.ok(helper.length>1000);
  const positions=[
    "readItmStageReceipt(episodeKey)",
    "parseGroundedEpisodes(savedEpisodes.responseText,input.batch)",
    'itmReceiptKey({...input,provider:"anthropic",stage:"retention",excerpts})',
    '"claim_itm_stage2_one_shot"',
    "permission.data!==true",
    'providerClient("anthropic",deadline)',
    'reconcileEpisodePlan(legacyEpisodes(input.summary),excerpts,"anthropic",client',
    "recordItmStageReceipt(",
    "parseRetentionPlan(retention.responseText",
    '"commit_intermediate_memory_checkpoint"',
  ].map(text=>helper.indexOf(text));
  for(let i=0;i<positions.length;i++)
    assert.ok(positions[i]>=0 && (i===0||positions[i]>positions[i-1]),
      "Expected safety ordering at position "+i);
  assert.match(helper,/SUMMARY_TIMEOUT_MS/);
  assert.match(helper,/if\(permission\.data!==true\)return null/);
  assert.doesNotMatch(helper,/summarizeNewBatch\(/);
  assert.match(helper,/input\.batch, \/\/ Stage 2 semantically checks the source of the saved Grok episodes/);
  assert.match(source,/parseSemanticRejections\(raw,newExcerpts\.length,Boolean\(sourceMessages\)\)/);
  assert.match(source,/ROLE-ATTRIBUTED SOURCE TRANSCRIPT/);
  assert.match(source,/maxRetries:0/);
  assert.match(source,/const rawFromResponse=\(response\.content\?\?\[\]\)/);
  assert.match(source,/if\(capture\)await capture\(rawFromResponse,response\.stop_reason==="end_turn",response\)/);
  assert.ok(source.indexOf('await capture(rawFromResponse,response.stop_reason==="end_turn",response)')<
    source.indexOf('raw = completedClaudeText(response, "retention plan"'));
  assert.ok(source.indexOf("const recoveredCrossProvider=await recoverOwnerApprovedCrossProviderStages")<
    source.indexOf("const recovered=await recoverCapturedItmStages"));
});

test("one-shot Stage 2 SQL grant prevents replay even for uncertain outcomes",{
  timeout:90000,skip:!process.env.KATIE_TEST_PG_BIN,
},async()=>{
  const bin=process.env.KATIE_TEST_PG_BIN;
  const root=mkdtempSync(join(tmpdir(),"katie-itm-stage2-")),data=join(root,"data");
  let server=false,client,peer;
  const run=(name,args)=>{
    const r=spawnSync(join(bin,name),args,{encoding:"utf8",timeout:30000});
    assert.equal(r.status,0,r.stderr||r.error?.message);
  };
  try{
    run("initdb",["-D",data,"-U","postgres","-A","trust","--no-locale","-E","UTF8"]);
    run("pg_ctl",["-D",data,"-l",join(root,"postgres.log"),"-o",
      `-h '' -k ${root} -p 55495`,"-w","start"]);
    server=true;
    client=new pg.Client({host:root,port:55495,user:"postgres",database:"postgres",connectionTimeoutMillis:5000});
    await client.connect();
    await client.query("create role service_role nologin bypassrls; create role anon nologin; create role authenticated nologin");
    await client.query(`
      create table public.chats(id uuid primary key, actor_id uuid not null);
      create table public.intermediate_memory(actor_id uuid not null,chat_id uuid not null,content jsonb not null);
      create table public.itm_stage_receipts(
        actor_id uuid not null,chat_id uuid not null,batch_end_message_id text not null,
        expected_cursor text not null,provider text not null,stage text not null,
        source_sha256 text not null,response_sha256 text not null
      );
    `);
    await client.query(migration);
    const actor=randomUUID(),other=randomUUID(),chat=randomUUID(),
      end=randomUUID(),cursor=randomUUID(),hash="a".repeat(64),
      context="b".repeat(64),stage1="c".repeat(64);
    await client.query("insert into chats(id,actor_id) values($1,$2)",[chat,actor]);
    await client.query("insert into intermediate_memory(actor_id,chat_id,content) values ($1,$2,$3)",
      [actor,chat,{summarizedThroughMessageId:cursor,sourceMessageCount:928}]);
    await client.query(`insert into itm_stage_receipts
      (actor_id,chat_id,batch_end_message_id,expected_cursor,provider,stage,source_sha256,response_sha256)
      values($1,$2,$3,$4,'grok','episodes',$5,$6)`,
      [actor,chat,end,cursor,hash,stage1]);
    await client.query(`insert into itm_stage2_one_shot_grants
      (actor_id,chat_id,batch_end_message_id,expected_cursor,source_sha256,
       context_sha256,stage1_response_sha256,owner_approval_reference)
      values($1,$2,$3,$4,$5,$6,$7,'test-owner-approval')`,
      [actor,chat,end,cursor,hash,context,stage1]);
    const call=async(a=actor,ctx=context,s1=stage1,c=cursor)=>(await client.query(
      "select public.claim_itm_stage2_one_shot($1,$2,$3,$4,$5,$6,$7) claimed",
      [a,chat,end,c,hash,ctx,s1])).rows[0].claimed;
    await client.query("set role service_role");
    await assert.rejects(call(other),/ITM_STAGE2_ACTOR_CHAT_MISMATCH/);
    assert.equal(await call(actor,hash),false,"wrong prior-summary context must not claim");
    assert.equal(await call(actor,context,hash),false,"wrong Stage 1 receipt hash must not claim");
    assert.equal(await call(actor,context,stage1,randomUUID()),false,"wrong cursor must not claim");
    peer=new pg.Client({host:root,port:55495,user:"postgres",database:"postgres",connectionTimeoutMillis:5000});
    await peer.connect();
    await peer.query("set role service_role");
    // Concurrent connections must serialize through PostgreSQL's row lock.
    const competing=await Promise.all([
      call(),
      peer.query("select public.claim_itm_stage2_one_shot($1,$2,$3,$4,$5,$6,$7) claimed",
        [actor,chat,end,cursor,hash,context,stage1]).then(r=>r.rows[0].claimed),
    ]);
    assert.equal(competing.filter(Boolean).length,1,"only one paid dispatch claim under concurrency");
    assert.equal(await call(),false,"no retries after first possible network contact");
    await assert.rejects(client.query("update itm_stage2_one_shot_grants set dispatched_at=null"),
      /permission denied/);
    await assert.rejects(client.query("insert into itm_stage2_one_shot_grants (actor_id) values($1)",[actor]),
      /permission denied/);
    await client.query("reset role");
    const proof=(await client.query(
      "select count(*)::int count, count(dispatched_at)::int spent from itm_stage2_one_shot_grants"
    )).rows[0];
    assert.deepEqual(proof,{count:1,spent:1});
    await assert.rejects(client.query(
      "update itm_stage2_one_shot_grants set stage1_response_sha256=$1",[hash]),
      /ITM_STAGE2_GRANT_IMMUTABLE/);
    await assert.rejects(client.query("delete from itm_stage2_one_shot_grants"),
      /ITM_STAGE2_GRANT_IMMUTABLE/);
    const access=(await client.query(`select
      has_table_privilege('anon','public.itm_stage2_one_shot_grants','SELECT') anon_read,
      has_table_privilege('authenticated','public.itm_stage2_one_shot_grants','SELECT') auth_read,
      has_table_privilege('service_role','public.itm_stage2_one_shot_grants','UPDATE') service_update,
      has_function_privilege('anon','public.claim_itm_stage2_one_shot(uuid,uuid,text,text,text,text,text)','EXECUTE') anon_rpc,
      has_function_privilege('service_role','public.claim_itm_stage2_one_shot(uuid,uuid,text,text,text,text,text)','EXECUTE') service_rpc
    `)).rows[0];
    assert.deepEqual(access,{anon_read:false,auth_read:false,service_update:false,
      anon_rpc:false,service_rpc:true});
  }finally{
    if(peer)await peer.end().catch(()=>undefined);
    if(client)await client.end().catch(()=>undefined);
    if(server)run("pg_ctl",["-D",data,"-m","immediate","-w","stop"]);
    rmSync(root,{recursive:true,force:true});
  }
});

test("blocked prior checkpoint attempt permits receipt-only CAS retry, never another Claude dispatch",()=>{
  const helper=source.slice(source.indexOf("async function recoverOwnerApprovedCrossProviderStages("),
    source.indexOf("export async function maybeUpdateSummary("));
  assert.match(helper,/claimed\.data!=="claimed"&&claimed\.data!=="blocked"/);
  assert.match(helper,/const newlyClaimed=claimed\.data==="claimed"/);
  assert.match(helper,/if\(newlyClaimed\)\{/);
  // The one-use provider claim is still acquired earlier and may not repeat.
  assert.match(helper,/if\(permission\.data!==true\)return null/);
  assert.ok(helper.indexOf('claim_itm_stage2_one_shot')<
    helper.indexOf('commit_intermediate_memory_checkpoint'));
  assert.doesNotMatch(helper,/summarizeNewBatch\(/);
});
