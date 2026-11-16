import test from "node:test";
import assert from "node:assert/strict";
import {prepareStandaloneRequest,estimatePreparedRequest,actualCostFromUsage} from "../lib/standalone-accounting/estimate";
import {getModelPrice,priceTokenUsage} from "../lib/standalone-accounting/pricing";
import {
  isBoundedGrokWebRequest,boundedGrokWebCostFromReceipt,
  boundedGrokWebReservationMicrousd,GROK_WEB_SEARCH_FEE_MICROUSD,
} from "../lib/standalone-accounting/grok-web-search";

const prepared=()=>prepareStandaloneRequest("grok","grok-4.3","/v1/responses",{
  model:"grok-4.3",input:[{role:"user",content:[{type:"input_text",text:"Look up Wild Horse Nine"}]}],
  tools:[{type:"web_search"}],include:["web_search_call.action.sources"],
  max_turns:1,parallel_tool_calls:false,max_output_tokens:2048,
});
test("official xAI search fee plus two worst-case context passes are reserved before dispatch",()=>{
  const request=prepared(),quote=estimatePreparedRequest(request),price=getModelPrice("grok","grok-4.3")!;
  assert.equal(isBoundedGrokWebRequest(request),true);
  assert.equal(quote.status,"estimated");
  assert.equal(quote.isCeiling,true);
  assert.equal(quote.estimatedCostMicrousd,
    (2n*BigInt(priceTokenUsage(price,price.maxContextTokens,2048))+GROK_WEB_SEARCH_FEE_MICROUSD).toString());
  assert.equal(quote.reservationMicrousd,boundedGrokWebReservationMicrousd(price,2048));
  assert.ok(BigInt(quote.reservationMicrousd!)>BigInt(priceTokenUsage(price,quote.inputTokens,2048)));
  assert.match(quote.assumptions.join(" "),/provider.*cost_in_usd_ticks|cost_in_usd_ticks/i);
});
test("xAI's direct provider cost ticks reconcile model and tool fees once",()=>{
  const request=prepared(),quote=estimatePreparedRequest(request);
  const usage={inputTokens:200,outputTokens:50,cachedInputTokens:0,
    cost_in_usd_ticks:60000000,num_server_side_tools_used:1,
    server_side_tool_usage_details:{web_search_calls:1,x_search_calls:0}};
  assert.equal(boundedGrokWebCostFromReceipt(usage,quote.reservationMicrousd!).actualMicrousd,"6000");
  assert.equal(actualCostFromUsage(request,usage).actualMicrousd,"6000");
  assert.equal(boundedGrokWebCostFromReceipt({...usage,cost_in_usd_ticks:60000001},quote.reservationMicrousd!).actualMicrousd,"6001");
});
test("unsupported xAI tool fields and unlimited turns never qualify as web research",()=>{
  const body=prepared().payload;
  for(const bad of [
    {...body,max_turns:3},{...body,parallel_tool_calls:true},
    {...body,max_output_tokens:4096},{...body,include:[]},
    {...body,tools:[{type:"web_search"},{type:"x_search"}]},
    {...body,tools:[{type:"web_search",enable_image_search:true}]},
    {...body,stream:true},
  ]){
    const r=prepareStandaloneRequest("grok","grok-4.3","/v1/responses",bad);
    assert.equal(isBoundedGrokWebRequest(r),false);
    assert.equal(estimatePreparedRequest(r).status,"unsupported");
  }
  assert.equal(estimatePreparedRequest(prepareStandaloneRequest("openai","gpt-4o","/v1/responses",{
    model:"gpt-4o",input:"Lookup",tools:[{type:"web_search"}]})).status,"unsupported");
});
test("missing xAI costs, unknown tool billing and exceeding authorization fail closed",()=>{
  const quote=estimatePreparedRequest(prepared());
  const base={cost_in_usd_ticks:60000000,server_side_tool_usage_details:{web_search_calls:1}};
  for(const invalid of [
    {...base,cost_in_usd_ticks:undefined},
    {...base,server_side_tool_usage_details:undefined},
    {...base,server_side_tool_usage_details:{web_search_calls:2}},
    {...base,server_side_tool_usage_details:{web_search_calls:1,code_interpreter_calls:1}},
    {...base,num_server_side_tools_used:2},
    {...base,cost_in_usd_ticks:1e12},
  ])assert.throws(()=>boundedGrokWebCostFromReceipt(invalid,quote.reservationMicrousd!));
});
