import test from "node:test";
import assert from "node:assert/strict";
import { planBestAnswerOutputTokens } from "../lib/providers/output-planning";
import { summarizeProviderOutcome } from "../lib/providers/response-diagnostics";
import { assertProviderOutput, ProviderResponseError } from "../lib/providers/response-errors";
import { runWithRefusalFallback } from "../lib/router/refusal-detection";
import { bestAnswerClaimSupported } from "../lib/router/best-answer-evidence";
import { estimatePreparedRequest, prepareStandaloneRequest } from "../lib/standalone-accounting/estimate";
import type { ChatGenerateParams, ProviderResponse } from "../lib/providers/types";

const twenty = Array.from({length: 20}, (_, i) =>
  `${i + 1}. Evaluate the independently verified executive qualification, challenge unsupported claims, and recommend corrections from a private equity operating partner perspective.`).join("\n");
const base: ChatGenerateParams = {
  name: "BTG Application Specialist", persona: "Verify every fact", summary: "",
  history: [], user: `Conduct a comprehensive, detailed executive profile review. Analyze all 20 qualifications with substantive recommendations:\n${twenty}`,
  modelId: "gpt-5.4-pro-2026-03-05", routingMode: "best_answer"
};
test("Best Answer plans substantive output plus reasoning from workload, not a universal 4,096-token cap", () => {
  const planned = planBestAnswerOutputTokens(base, base.modelId!);
  assert.ok(planned && planned > 16_000 && planned < 128_000, "sufficient headroom for visible report and hidden reasoning");
  const shorter: ChatGenerateParams = {...base, user: base.user.split("\n").slice(0, 10).join("\n")};
  const shortCap = planBestAnswerOutputTokens(shorter, base.modelId!);
  assert.ok(shortCap && shortCap < planned, "scope determines allowance");
  assert.equal(planBestAnswerOutputTokens({...base, routingMode:"best_value"}, base.modelId!), undefined);
  assert.equal(planBestAnswerOutputTokens({...base, user:"Hi there."}, base.modelId!), undefined);
  assert.equal(planBestAnswerOutputTokens(base, "unreviewed-model"), undefined);
});

test("long-form allowance is a frozen, priced request subject to ordinary context and accounting limits", () => {
  const cap = planBestAnswerOutputTokens(base, base.modelId!)!;
  const prepared = prepareStandaloneRequest("openai", base.modelId!, "/v1/responses",
    {model:base.modelId, input:[{role:"user",content:base.user}], max_output_tokens:cap});
  const quote = estimatePreparedRequest(prepared);
  assert.equal(quote.status,"estimated",quote.issues.join(", "));
  assert.equal(quote.outputAllowance,cap);
  assert.equal(quote.requestHash,prepared.hash);
  assert.ok(BigInt(quote.reservationMicrousd!) > 0n);
  const routine = prepareStandaloneRequest("openai",base.modelId!,"/v1/responses",
    {model:base.modelId,input:[{role:"user",content:"Hi"}]});
  assert.equal(routine.payload.max_output_tokens,4096,"other requests retain their original behavior");
});

test("provider-reported reasoning exhaustion never repeats the identical paid attempt", async () => {
  let calls = 0;
  const reply: ProviderResponse = {provider:"openai",model:base.modelId!,text:"",responseStatus:"incomplete",
    incompleteReason:"max_output_tokens",usage:{inputTokens:100072,outputTokens:4096,reasoningTokens:4096}};
  await assert.rejects(runWithRefusalFallback({
    attempts:["same-request"],runAttempt:async()=>{calls++;return reply;},
    shouldRetryRefusal:true,detectRefusal:()=>false,
    rerouteOnError:async()=>{throw Error("must not automatically reroute output exhaustion");}
  }), (error:unknown)=>error instanceof ProviderResponseError &&
    error.code==="OUTPUT_TOKEN_EXHAUSTED" && error.retryable===false);
  assert.equal(calls,1);
});

test("partial visible text cannot disguise an incomplete output-exhausted response", () => {
  assert.throws(()=>assertProviderOutput({provider:"openai",model:base.modelId!,text:"unfinished analysis",
    responseStatus:"incomplete",incompleteReason:"max_output_tokens"}),
    (error:unknown)=>error instanceof ProviderResponseError && error.code==="OUTPUT_TOKEN_EXHAUSTED");
});
test("provider refusal, provider failure and normal completed response are distinguishable", () => {
  assert.throws(()=>assertProviderOutput({provider:"openai",model:base.modelId!,text:"",
    responseStatus:"incomplete",incompleteReason:"content_filter"}),
    (error:unknown)=>error instanceof ProviderResponseError && error.code==="PROVIDER_REFUSAL");
  assert.throws(()=>assertProviderOutput({provider:"openai",model:base.modelId!,text:"",
    responseStatus:"failed"}), (error:unknown)=>error instanceof ProviderResponseError && error.code==="PROVIDER_FAILURE");
  assert.doesNotThrow(()=>assertProviderOutput({provider:"openai",model:base.modelId!,text:"Substantive independent assessment.",
    responseStatus:"completed"}));
});

test("durable OpenAI diagnostics identify billed reasoning exhaustion without retaining sensitive content", () => {
  const secret = "CONFIDENTIAL RESUME MATERIAL AND SECRET KEY";
  const raw = JSON.stringify({id:"resp_case",status:"incomplete",incomplete_details:{reason:"max_output_tokens"},
    output:[{type:"reasoning",summary:[{text:secret}]}],
    usage:{input_tokens:100072,output_tokens:4096,output_tokens_details:{reasoning_tokens:4096}}});
  const evidence = summarizeProviderOutcome(raw,"openai","/v1/responses",false,200);
  assert.equal(evidence.providerResponseStatus,"incomplete");
  assert.equal(evidence.providerIncompleteReason,"max_output_tokens");
  assert.equal(evidence.normalizedFailureReason,"OUTPUT_TOKEN_EXHAUSTED");
  assert.equal(evidence.reasoningTokens,4096);
  assert.equal(evidence.hasVisibleOutput,false);
  assert.equal(evidence.streamComplete,true);
  assert.doesNotMatch(JSON.stringify(evidence),/CONFIDENTIAL|SECRET|resp_case/);
});

test("streaming final incomplete event preserves terminal metadata", () => {
  const event={type:"response.incomplete",response:{id:"resp_case",status:"incomplete",
    incomplete_details:{reason:"max_output_tokens"},
    usage:{input_tokens:19,output_tokens:15,output_tokens_details:{reasoning_tokens:15}}}};
  const evidence=summarizeProviderOutcome(`data: ${JSON.stringify(event)}\n\n`,"openai","/v1/responses",true,200);
  assert.equal(evidence.normalizedFailureReason,"OUTPUT_TOKEN_EXHAUSTED");
  assert.equal(evidence.streamComplete,true);
  assert.equal(evidence.reasoningTokens,15);
});

test("other providers and HTTP rejection remain separately classified", () => {
  assert.equal(summarizeProviderOutcome(JSON.stringify({candidates:[{finishReason:"MAX_TOKENS"}]}),
    "google","/v1beta/models/gemini-2.5-pro:generateContent",false,200).normalizedFailureReason,"OUTPUT_TOKEN_EXHAUSTED");
  assert.equal(summarizeProviderOutcome(JSON.stringify({error:{code:"model_not_found",message:"do not log this"}}),
    "openai","/v1/responses",false,404).normalizedFailureReason,"UNSUPPORTED_MODEL");
  assert.equal(summarizeProviderOutcome(JSON.stringify({error:{code:"context_length_exceeded"}}),
    "openai","/v1/responses",false,400).normalizedFailureReason,"CONTEXT_CAPACITY_EXHAUSTED");
  assert.equal(summarizeProviderOutcome("","openai","/v1/responses",false,504).normalizedFailureReason,"TIMEOUT");
});

test("Best Answer rejects fabricated prior task-quality evidence; delivery alone proves nothing", () => {
  const claim="Chosen for proven high analytical precision in earlier interactions.";
  const priorDelivery={quality:{feedback:{evidence:[]}}};
  assert.equal(bestAnswerClaimSupported(claim,[],priorDelivery),false);
  assert.equal(bestAnswerClaimSupported("Comparable answer quality is unknown.",[],priorDelivery),true);
  const falseAlternative=[{whyNotSelected:"The winner has an established track record from a prior completed message."}];
  assert.equal(bestAnswerClaimSupported("Reasoned selection only",falseAlternative),false);
  const feedback={quality:{feedback:{evidence:[{outcome:"positive",source:"internal_review",
    task_excerpt:"Earlier comprehensive executive qualification review",dimension:"task_quality"}]}}};
  assert.equal(bestAnswerClaimSupported(claim,[],feedback),true);
});
