import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import {createHash} from "node:crypto";
import ts from "typescript";

const source=readFileSync("lib/memory/itm-stage-receipts.ts","utf8");
const migration=readFileSync("supabase/migrations/20261116194000_itm_stage2_one_shot_grant.sql","utf8");
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const key={actorId:"actor",chatId:"chat",batchEndMessageId:"end",expectedCursor:"cursor",
  provider:"anthropic",stage:"retention",sourceSha256:"a".repeat(64),contextSha256:"b".repeat(64)};
function fixture(){
  const rows=[];
  const admin={from:(table)=>{
    assert.equal(table,"itm_stage2_dispatch_outcomes");
    return {
      insert:async value=>{
        if(rows.length)return {error:{code:"23505"}};
        rows.push(value);
        return {error:null};
      },
      select:()=>({
        eq(){return this;},
        async maybeSingle(){
          return {data:rows[0]?{status:rows[0].status,raw_response_sha256:rows[0].raw_response_sha256}:null,error:null};
        },
      }),
    };
  }};
  const module={exports:{}};
  runInNewContext(compiled,{
    module,exports:module.exports,
    require:name=>name==="node:crypto"?{createHash}:
      name==="@/lib/data/supabase/admin"?{getSupabaseAdminClient:()=>admin}:assert.fail("unknown import"),
  });
  return {api:module.exports,rows};
}
test("full oversized/incomplete Claude response is captured without truncation or rewriting",async()=>{
  const h=fixture();
  const response={stop_reason:"max_tokens",content:[{type:"text",text:"x".repeat(25000)}],usage:{input_tokens:2,output_tokens:2800}};
  await h.api.recordItmOneShotOutcome(key,{status:"response",response});
  assert.deepEqual(JSON.parse(h.rows[0].raw_response_text),response);
  assert.equal(h.rows[0].raw_response_sha256,createHash("sha256").update(h.rows[0].raw_response_text).digest("hex"));
  await h.api.recordItmOneShotOutcome(key,{status:"uncertain"});
  assert.equal(h.rows.length,1);
  await assert.rejects(h.api.recordItmOneShotOutcome(key,{status:"response",response:{content:[]}}),/IMMUTABLE_CONFLICT/);
});
test("empty-text completion and uncertainty are preserved as distinct immutable outcomes",async()=>{
  const h=fixture();
  await h.api.recordItmOneShotOutcome(key,{status:"response",response:{stop_reason:"end_turn",content:[]}});
  assert.deepEqual(JSON.parse(h.rows[0].raw_response_text).content,[]);
  const u=fixture();
  await u.api.recordItmOneShotOutcome(key,{status:"uncertain"});
  assert.equal(u.rows[0].raw_response_text,null);
  assert.equal(u.rows[0].status,"uncertain");
});
test("one-shot outcome table is service-only and immutable",()=>{
  assert.match(migration,/itm_stage2_dispatch_outcomes enable row level security/);
  assert.match(migration,/revoke all on public\.itm_stage2_dispatch_outcomes from public,anon,authenticated,service_role/);
  assert.match(migration,/grant select,insert on public\.itm_stage2_dispatch_outcomes to service_role/);
  assert.match(migration,/ITM_STAGE2_OUTCOME_IMMUTABLE/);
});
