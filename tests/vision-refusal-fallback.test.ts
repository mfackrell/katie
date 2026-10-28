import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isExplicitVisionPolicyRefusal, selectGrokVisionFallback } from "../lib/chat/vision-refusal-fallback";
import { isLikelyProviderRefusal, runWithRefusalFallback } from "../lib/router/refusal-detection";
import type { ProviderResponse } from "../lib/providers/types";
import { ProviderResponseError } from "../lib/providers/response-errors";

const result = (text: string): ProviderResponse => ({provider:"openai",model:"gpt-4o-mini",text});
test("recognizes contracted and uncontracted generic inability variants", () => {
  for (const refusal of [
    "I'm unable to assist with that.",
    "I am unable to assist with that.",
    "I can't assist with that.",
    "I cannot help with this.",
    "I won't answer your request."
  ]) assert.equal(isLikelyProviderRefusal(result(refusal),"openai"),true,refusal);
  assert.equal(isLikelyProviderRefusal(result("A red sailboat on the water."),"openai"),false);
});
test("a stated policy refusal is never treated as generic incapacity", () => {
  assert.equal(isExplicitVisionPolicyRefusal("I'm unable to assist because this violates our content policy."),true);
  assert.equal(isExplicitVisionPolicyRefusal("I can't assist with that."),false);
});
test("vision fallback selects a Grok analysis model, not imagine/video/generation", () => {
  assert.equal(selectGrokVisionFallback(["grok-4-imagine","grok-4.7","grok-3","grok-4-video"]),"grok-4.7");
  assert.equal(selectGrokVisionFallback(["grok-4-imagine","grok-4-video"]),null);
});
test("a generic inability triggers one Grok vision continuation",async()=>{
  const calls:string[]=[];
  const response=await runWithRefusalFallback({
    attempts:["openai"] as string[],
    shouldRetryRefusal:true,
    retryExplicitContentRefusal:false,
    runAttempt:async candidate=>{
      calls.push(candidate);
      return {provider:candidate==="grok"?"grok":"openai",model:candidate,text:candidate==="grok"?"A dog beside a window.":"I'm unable to assist with that."};
    },
    detectRefusal:(reply)=>!isExplicitVisionPolicyRefusal(reply.text)&&isLikelyProviderRefusal(reply,reply.provider),
    rerouteOnRefusal:async ({attempt})=>attempt==="openai"?"grok":null
  });
  assert.deepEqual(calls,["openai","grok"]);
  assert.equal(response.result.text,"A dog beside a window.");
});
test("an upstream explicit safety block never invokes a second provider in vision mode",async()=>{
  let calls=0;
  await assert.rejects(runWithRefusalFallback({
    attempts:["openai","grok"],shouldRetryRefusal:true,retryExplicitContentRefusal:false,
    runAttempt:async ()=>{calls++;throw new ProviderResponseError("Safety policy rejected input",false,"PROHIBITED_CONTENT");},
    detectRefusal:()=>true,
    rerouteOnRefusal:async()=> "grok"
  }),/Safety policy|declined/);
  assert.equal(calls,1);
});
test("chat route wires the Grok fallback only to still-image vision",()=>{
  const code=readFileSync("app/api/chat/route.ts","utf8");
  assert.match(code,/stillImageVisionRequest = resolvedRequestIntent === "vision-analysis" && rerouteHasVisualInput && !hasVideoInput/);
  assert.match(code,/selectGrokVisionFallback\(await grokProvider\.listModels\(\)\)/);
  assert.match(code,/retryExplicitContentRefusal: !stillImageVisionRequest/);
});
