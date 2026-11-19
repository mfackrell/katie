import test from "node:test";
import assert from "node:assert/strict";
import { planBestAnswerOutputTokens } from "../lib/providers/output-planning";
import { summarizeProviderOutcome } from "../lib/providers/response-diagnostics";
import { assertProviderOutput, ProviderResponseError } from "../lib/providers/response-errors";
import { runWithRefusalFallback } from "../lib/router/refusal-detection";
import { estimatePreparedRequest, prepareStandaloneRequest } from "../lib/standalone-accounting/estimate";
import type { ChatGenerateParams, ProviderResponse } from "../lib/providers/types";
import { OpenAiProvider } from "../lib/providers/openai-provider";
import { GrokProvider } from "../lib/providers/grok-provider";

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

test("long-form Google and Grok candidates also receive scoped, reviewed output allowances", () => {
  const googleCap = planBestAnswerOutputTokens({...base, modelId:"gemini-2.5-pro"},"gemini-2.5-pro","google");
  const grokCap = planBestAnswerOutputTokens({...base, modelId:"grok-4.7"},"grok-4.7","grok");
  assert.ok(googleCap && googleCap > 4096);
  assert.ok(grokCap && grokCap > 4096 && grokCap <= 30_000);
  assert.equal(planBestAnswerOutputTokens({...base, routingMode:"best_value"},
    "gemini-2.5-pro","google"),undefined);
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
test("a provider-declared completed but entirely invisible answer is distinct from an unclassified empty response", () => {
  assert.throws(()=>assertProviderOutput({provider:"openai",model:base.modelId!,text:"",
    responseStatus:"completed",usage:{inputTokens:100,outputTokens:100,reasoningTokens:100}}),
    (error:unknown)=>error instanceof ProviderResponseError && error.code==="COMPLETED_EMPTY_RESPONSE" && !error.retryable);
});

test("provider refusal, provider failure and normal completed response are distinguishable", () => {
  assert.throws(()=>assertProviderOutput({provider:"openai",model:base.modelId!,text:"",
    responseStatus:"incomplete",incompleteReason:"content_filter"}),
    (error:unknown)=>error instanceof ProviderResponseError && error.code==="PROVIDER_REFUSAL");
  assert.throws(()=>assertProviderOutput({provider:"openai",model:base.modelId!,text:"",
    responseStatus:"failed"}), (error:unknown)=>error instanceof ProviderResponseError && error.code==="PROVIDER_FAILURE");
  assert.throws(()=>assertProviderOutput({provider:"openai",model:base.modelId!,text:"",
    responseStatus:"completed",content:[{type:"refusal",refusal:"cannot comply"}]}),
    (error:unknown)=>error instanceof ProviderResponseError && error.code==="PROVIDER_REFUSAL");
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

test("provider-declared refusal is not mislogged as a generic invisible completion", () => {
  const outcome=summarizeProviderOutcome(JSON.stringify({status:"completed",
    output:[{type:"message",content:[{type:"refusal",refusal:"I cannot comply"}]}]}),
    "openai","/v1/responses",false,200);
  assert.equal(outcome.normalizedFailureReason,"PROVIDER_REFUSAL");
  assert.equal(outcome.hasVisibleOutput,false);
  assert.doesNotMatch(JSON.stringify(outcome),/cannot comply/);
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

// B1: Fake the SDK client; no provider API, paid inference, or live billing.
test("OpenAI and Grok Chat Completions length cannot repeat empty or partial paid answers", async () => {
  for (const providerName of ["openai", "grok"] as const) {
    for (const partialText of ["", "unfinished executive review"]) {
      const modelId = providerName === "openai" ? "gpt-4o" : "grok-4.7";
      const provider = providerName === "openai" ? new OpenAiProvider("offline")
        : new GrokProvider("offline");
      if (providerName === "grok") provider.listModels = async () => [modelId];
      let transmissions = 0;
      Reflect.set(provider, "client", { chat: { completions: { create: async () => {
        transmissions += 1;
        return { model:modelId, choices:[{ finish_reason:"length",
          message:{role:"assistant",content:partialText} }] };
      } } } });
      await assert.rejects(runWithRefusalFallback({
        attempts:["same-paid-attempt"],
        runAttempt:async()=>provider.generate({...base,user:"Finish the review.",modelId}),
        shouldRetryRefusal:true,detectRefusal:()=>false,
        rerouteOnError:async()=>{throw Error("exhaustion cannot reroute or repeat");}
      }), (error:unknown)=>error instanceof ProviderResponseError &&
        error.code==="OUTPUT_TOKEN_EXHAUSTED" && error.retryable===false);
      assert.equal(transmissions,1,providerName+" must not dispatch twice");
    }
  }
});

test("Chat Completions stop is propagated and the answer remains usable", async () => {
  for (const providerName of ["openai","grok"] as const) {
    const modelId = providerName === "openai" ? "gpt-4o" : "grok-4.7";
    const provider = providerName === "openai" ? new OpenAiProvider("offline")
      : new GrokProvider("offline");
    if (providerName === "grok") provider.listModels = async () => [modelId];
    Reflect.set(provider,"client",{chat:{completions:{create:async()=>
      ({model:modelId,choices:[{finish_reason:"stop",
        message:{role:"assistant",content:"The assessment is complete."}}]})}}});
    const reply=await provider.generate({...base,user:"Finish.",modelId});
    assert.equal(reply.finishReason,"stop");
    assert.doesNotThrow(()=>assertProviderOutput(reply));
  }
});

test("Grok bounded video-frame truncation remains observable without changing ordinary chat safety", async () => {
  const grok=new GrokProvider("offline");
  grok.listModels=async()=>["grok-4.7"];
  Reflect.set(grok,"client",{chat:{completions:{create:async()=>({
    model:"grok-4.7",choices:[{finish_reason:"length",message:{content:"frame partial"}}]
  })}}});
  const reply=await grok.generate({...base,modelId:"grok-4.7",boundedFrameObservations:true});
  assert.equal(reply.truncated,true);
  assert.equal(reply.finishReason,undefined);
});

test("OpenAI Chat Completions stream rejects length or missing finish reason without retransmission", async () => {
  for (const finishReason of ["length","stop",null] as const) {
    for (const value of ["","Partial assessment"]) {
      const provider = new OpenAiProvider("offline");
      let transmissions=0;
      Reflect.set(provider,"client",{chat:{completions:{create:async()=>{
        transmissions += 1;
        return { async *[Symbol.asyncIterator]() {
          yield {model:"gpt-4o",choices:[{delta:{content:value},finish_reason:null}]};
          if (finishReason) yield {model:"gpt-4o",
            choices:[{delta:{},finish_reason:finishReason}]};
        }};
      }}}});
      const run=()=>runWithRefusalFallback({
        attempts:["same-stream"],
        runAttempt:async()=>provider.generateStream({...base,user:"Finish.",modelId:"gpt-4o"},{onTextDelta:()=>{}}),
        shouldRetryRefusal:true,detectRefusal:()=>false
      });
      if (finishReason === "stop" && value) {
        const {result}=await run();
        assert.equal(result.finishReason,"stop");
      } else {
        const expected=finishReason===null ? "PROVIDER_TERMINAL_MISSING" :
          finishReason==="length" ? "OUTPUT_TOKEN_EXHAUSTED" : "COMPLETED_EMPTY_RESPONSE";
        await assert.rejects(run(),(error:unknown)=>error instanceof ProviderResponseError &&
          error.code===expected && error.retryable===false);
      }
      assert.equal(transmissions,1,"stream completion is not retried");
    }
  }
});

test("Anthropic SSE diagnostics require message_stop beyond message_delta", () => {
  const events = [
    { type:"message_start",message:{usage:{input_tokens:10,output_tokens:0}} },
    { type:"content_block_delta",delta:{type:"text_delta",text:"Unfinished private review"} },
    { type:"message_delta",delta:{stop_reason:"end_turn"},usage:{output_tokens:7} }
  ];
  const toSse=(arr:unknown[])=>arr.map(v=>"data: "+JSON.stringify(v)+"\n\n").join("");
  const partial=summarizeProviderOutcome(toSse(events),"anthropic","/v1/messages",true,200);
  const doneOnly=summarizeProviderOutcome(toSse(events)+"data: [DONE]\n\n",
    "anthropic","/v1/messages",true,200);
  const completed=summarizeProviderOutcome(toSse([...events,{type:"message_stop"}]),
    "anthropic","/v1/messages",true,200);
  assert.equal(partial.streamComplete,false);
  assert.equal(doneOnly.streamComplete,false,"Anthropic has no [DONE] terminal");
  assert.equal(completed.streamComplete,true);
  assert.equal(completed.providerFinishReason,"end_turn");
  assert.doesNotMatch(JSON.stringify(partial),/Unfinished private review/);
});

test("Grok Chat Completions SSE diagnostics classify length with partial visible text", () => {
  const chunks=[
    {choices:[{delta:{content:"partial"},finish_reason:null}]},
    {choices:[{delta:{},finish_reason:"length"}]},
  ];
  const body=chunks.map(v=>"data: "+JSON.stringify(v)+"\n\n").join("")+"data: [DONE]\n\n";
  const result=summarizeProviderOutcome(body,"grok","/v1/chat/completions",true,200);
  assert.equal(result.streamComplete,true);
  assert.equal(result.providerFinishReason,"length");
  assert.equal(result.normalizedFailureReason,"OUTPUT_TOKEN_EXHAUSTED");
  assert.equal(result.hasVisibleOutput,true);
});
