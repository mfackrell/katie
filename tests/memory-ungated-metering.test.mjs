import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import {randomUUID} from "node:crypto";

const activitySource=readFileSync("lib/standalone-accounting/activity.ts","utf8");
const memorySource=readFileSync("lib/memory/metered-fetch.ts","utf8");
const migration=readFileSync("supabase/migrations/20261116140000_memory_ungated_usage_telemetry.sql","utf8");
const versionSource=readFileSync("lib/memory/summarizer.ts","utf8");
const expectedActivities=["memory-summary","memory-relevance","memory-edit","memory-maintenance","memory-extraction"];

function harness({dbError=false,providerResponse=null,throwTransport=false}={}){
  const rows=[],requests=[],diagnostics=[];
  const exports={};
  const fakeFetch=async(input,init)=>{
    requests.push({input,init});
    if(throwTransport)throw Error("Synthetic provider network failure");
    return providerResponse??new Response(JSON.stringify({
      usage:{input_tokens:120,output_tokens:40,input_tokens_details:{cached_tokens:20}},
    }),{status:200,headers:{"content-type":"application/json"}});
  };
  const pricing={
    PRICING_VERSION:"test-reviewed-rates",
    getModelPrice:(_provider,_model)=>({inputNanoUsd:"2000",outputNanoUsd:"6000",cachedInputNanoUsd:"500"}),
    priceTokenUsage:(_price,input,output,cached)=>
      String(Math.ceil(((input-cached)*2000+cached*500+output*6000)/1000)),
  };
  vm.runInNewContext(ts.transpileModule(memorySource,{compilerOptions:{
    module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022
  }}).outputText,{
    exports,require(name){
      if(name==="node:crypto")return {randomUUID};
      if(name==="@/lib/data/supabase/admin")return {getSupabaseAdminClient:()=>({
        from:table=>{
          assert.equal(table,"memory_provider_usage");
          return {insert:async row=>{
            rows.push(row);
            return {error:dbError?{message:"Database temporarily unavailable"}:null};
          }};
        },
      })};
      if(name==="@/lib/standalone-accounting/context")return {getAccountingScope:()=>({kind:"standalone",context:{
        userId:"11111111-1111-4111-8111-111111111111",
        actorId:"22222222-2222-4222-8222-222222222222",
        chatId:"33333333-3333-4333-8333-333333333333",
        requestId:"finished-http-lease",
      }})};
      if(name==="@/lib/standalone-accounting/pricing")return pricing;
      throw Error("Unexpected import "+name);
    },
    URL,Request,Response,AbortController,AbortSignal,setTimeout,clearTimeout,Date,
    console:{error:(...a)=>diagnostics.push(a)},
    fetch:fakeFetch,
  });
  return {exports,rows,requests,diagnostics,fakeFetch};
}

test("all five memory activities bypass owner request approval and lease checks",async()=>{
  const h=harness({dbError:true});
  for(const activity of expectedActivities){
    const transport=h.exports.createMemoryMeteredFetch("grok",activity,{},h.fakeFetch);
    const response=await transport("https://api.x.ai/v1/responses",{
      method:"POST",body:JSON.stringify({model:"grok-4.7",input:"synthetic"}),
    });
    assert.equal(response.status,200);
  }
  assert.equal(h.requests.length,5);
  assert.equal(h.rows.length,5);
  assert.equal(h.diagnostics.length,5);
  assert.ok(h.rows.every(r=>r.activity.startsWith("memory-") && r.status==="completed"));
  assert.ok(h.rows.every(r=>r.cost_microusd==="450"));
});

test("memory cost telemetry does not replace user request accounting",()=>{
  assert.match(activitySource,/if\(MEMORY_ACTIVITIES\.has\(activity\)\)return createMemoryMeteredFetch/);
  assert.match(activitySource,/createAccountingFetchWithPolicy\(provider,policy\)/);
  assert.match(activitySource,/runWithStandaloneActivity\(activity,\(\)=>transport\(input,init\)\)/);
  assert.throws(()=>harness().exports.createMemoryMeteredFetch("grok","chat"),/Memory-only/);
  for(const activity of expectedActivities)assert.ok(memorySource.includes('"'+activity+'"'));
});

test("memory provider errors still reach caller and are recorded without budget veto",async()=>{
  const h=harness({throwTransport:true,dbError:true});
  const transport=h.exports.createMemoryMeteredFetch("anthropic","memory-edit",{},h.fakeFetch);
  await assert.rejects(transport("https://api.anthropic.com/v1/messages",{method:"POST",body:JSON.stringify({model:"claude-sonnet-5-5"})}),/Synthetic provider network failure/);
  assert.equal(h.requests.length,1);
  assert.equal(h.rows.length,1);
  assert.equal(h.rows[0].status,"transport_error");
  assert.equal(h.rows[0].cost_microusd,null);
});

test("native Claude receipt captures cached reads and writes with reviewed rate",async()=>{
  const h=harness({providerResponse:new Response(JSON.stringify({
    usage:{input_tokens:100,output_tokens:50,cache_read_input_tokens:25,cache_creation_input_tokens:10},
  }),{status:200,headers:{"content-type":"application/json"}})});
  const transport=h.exports.createMemoryMeteredFetch("anthropic","memory-summary",{},h.fakeFetch);
  await transport("https://api.anthropic.com/v1/messages",{method:"POST",body:JSON.stringify({model:"claude-sonnet-5-5"})});
  assert.equal(h.rows[0].input_tokens,135);
  assert.equal(h.rows[0].cached_input_tokens,25);
  assert.equal(h.rows[0].cache_write_input_tokens,10);
});

test("metering never bypasses provider destination constraints or ITM recovery fences",async()=>{
  const h=harness();
  await assert.rejects(h.exports.createMemoryMeteredFetch("grok","memory-summary",{},h.fakeFetch)(
    "https://not-x.ai/v1/responses",{method:"POST",body:'{}'}),/Unexpected memory provider destination/);
  assert.equal(h.requests.length,0);
  assert.match(versionSource,/two-stage-30-messages-v15-semantic-episode-review/);
  assert.match(versionSource,/inspection\.data\.in_flight/);
  assert.match(versionSource,/inspection\.data\.grok_sent/);
  assert.match(versionSource,/inspection\.data\.anthropic_sent/);
  assert.match(versionSource,/p_expected_cursor: expectedCursor/);
  assert.match(migration,/enable row level security/);
  assert.match(migration,/revoke all on public\.memory_provider_usage from public, anon, authenticated/);
  assert.match(migration,/grant select, insert on public\.memory_provider_usage to service_role/);
});
