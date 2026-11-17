import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import {createHash} from "node:crypto";
import ts from "typescript";

const source=readFileSync("lib/memory/itm-stage-receipts.ts","utf8");
const schema=readFileSync("supabase/migrations/20261116155000_itm_stage_receipt_recovery.sql","utf8");
const summary=readFileSync("lib/memory/summarizer.ts","utf8");

function fixture(){
  const rows=[],calls=[];
  const db={
    from(name){
      calls.push({method:"from",name});
      if(name==="itm_stage_receipts"){
        const filters={};
        const query={
          select(){return this},
          eq(key,value){filters[key]=value;return this},
          async maybeSingle(){
            const row=rows.find(r=>Object.entries(filters).every(([k,v])=>r[k]===v));
            return {data:row??null,error:null};
          },
        };
        return {
          ...query,
          async insert(row){
            const found=rows.some(r=>["actor_id","chat_id","batch_end_message_id","provider",
              "stage","source_sha256","context_sha256"].every(k=>r[k]===row[k]));
            if(found)return {error:{message:"unique violation"}};
            rows.push({...row});return {error:null};
          },
        };
      }
      if(name==="intermediate_memory_batch_attempts"){
        return {
          select(){return this},
          eq(){return this},
          async returns(){return {data:[
            {processor_version:"two-stage-30-messages-v13-memory-ungated-metered:anthropic",state:"blocked"},
          ],error:null}},
        };
      }
      throw Error("Unexpected table "+name);
    },
  };
  const mod={exports:{}};
  runInNewContext(ts.transpileModule(source,{compilerOptions:{
    module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,
  }}).outputText,{
    module:mod,exports:mod.exports,
    require(name){
      if(name==="node:crypto")return {createHash};
      if(name==="@/lib/data/supabase/admin")return {getSupabaseAdminClient:()=>db};
      throw Error("Forbidden import "+name);
    },
  });
  return {api:mod.exports,rows,calls};
}
const digest=value=>createHash("sha256").update(value).digest("hex");
const key={
  actorId:"11111111-1111-4111-8111-111111111111",
  chatId:"22222222-2222-4222-8222-222222222222",
  batchEndMessageId:"33333333-3333-4333-8333-333333333333",
  expectedCursor:"44444444-4444-4444-8444-444444444444",
  provider:"anthropic",stage:"episodes",
  sourceSha256:digest("source"),contextSha256:digest("stage prompt"),
};

test("provider stage evidence saves exact bytes and verifies integrity without inference",async()=>{
  const h=fixture(),raw='{"episodes":[]}';
  assert.equal(await h.api.readItmStageReceipt(key),null);
  const stored=await h.api.recordItmStageReceipt(key,raw,"v14");
  assert.equal(stored.responseSha256,digest(raw));
  assert.equal(h.rows.length,1);
  assert.equal(h.rows[0].response_text,raw);
  assert.equal((await h.api.readItmStageReceipt(key)).responseText,raw);
  assert.equal((await h.api.recordItmStageReceipt(key,raw,"v14")).responseSha256,digest(raw));
});

test("an incomplete Claude response stays immutable but cannot be replayed as a valid plan",async()=>{
  const h=fixture();
  const stage={...key,stage:"retention"};
  const raw='{"keep":[0]}';
  const saved=await h.api.recordItmStageReceipt(stage,raw,"v15-owner-stage2:incomplete");
  assert.equal(saved.responseSha256,digest(raw));
  assert.equal(h.rows.length,1);
  assert.equal(h.rows[0].processor_version,"v15-owner-stage2:incomplete");
  assert.equal(await h.api.readItmStageReceipt(stage),null);
});

test("stage evidence rejects different output for the same immutable source",async()=>{
  const h=fixture();
  await h.api.recordItmStageReceipt(key,'{"episodes":[]}',"v14");
  await assert.rejects(h.api.recordItmStageReceipt(key,'{"episodes":[1]}',"v15"),/ITM_RECEIPT_WRITE_UNAVAILABLE_OR_CONFLICT/);
  assert.equal(h.rows.length,1);
  h.rows[0].response_text='{"episodes":[2]}';
  await assert.rejects(h.api.readItmStageReceipt(key),/ITM_RECEIPT_INTEGRITY_FAILED/);
});

test("stage read refuses a different expected cursor even with matching source hash",async()=>{
  const h=fixture();await h.api.recordItmStageReceipt(key,'{"episodes":[]}',"v14");
  await assert.rejects(h.api.readItmStageReceipt({...key,expectedCursor:"wrong"}),
    /ITM_RECEIPT_CURSOR_MISMATCH/);
});

test("provider exposure is fenced across v13 without relying on the old accounting ledger",async()=>{
  const h=fixture();
  const claims=await h.api.inspectPriorItmClaims(key.actorId,key.chatId,key.batchEndMessageId);
  assert.deepEqual(JSON.parse(JSON.stringify(claims)),{grok:false,anthropic:true});
  assert.equal(h.calls.some(c=>c.name==="standalone_provider_attempts"),false);
  assert.match(summary,/inspectPriorItmClaims/);
  assert.match(summary,/recoverCapturedItmStages/);
});

test("receipt RLS, service-role-only insert, immutable trigger and response-size limits",()=>{
  assert.match(schema,/enable row level security/);
  assert.match(schema,/revoke all on public\.itm_stage_receipts from public,anon,authenticated/);
  assert.match(schema,/grant select,insert on public\.itm_stage_receipts to service_role/);
  assert.match(schema,/before update or delete/);
  assert.match(schema,/ITM_STAGE_RECEIPT_IMMUTABLE/);
  assert.match(schema,/length\(response_text\) between 1 and 16000/);
  assert.doesNotMatch(source,/fetch\(|generate\(|createActivityAccountingFetch/);
});

test("source-bound stage evidence is not logged as prose or counted as new budgeted work",()=>{
  assert.match(summary,/ITM_VALIDATION_EPISODE_SUMMARY_LENGTH/);
  assert.match(summary,/ITM_VALIDATION_EPISODE_EVIDENCE_COUNT/);
  assert.match(summary,/recordItmStageReceipt/);
  assert.match(summary,/p_expected_cursor:input.expectedCursor/);
  assert.match(summary,/p_processor_version:claimVersion/);
  assert.doesNotMatch(source,/console\.(log|info|warn).*responseText/);
});
