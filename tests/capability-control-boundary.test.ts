import test from "node:test";
import assert from "node:assert/strict";
import {
  CAPABILITY_REQUEST_PREFIX,hasCapabilityEscalationMarker,
  parseCapabilityEscalationRequest,runCapabilityAwareGeneration,
} from "../lib/collaboration/capability-escalation";
import {runOnDemandCapabilityEscalation} from "../lib/collaboration/capability-escalation-runner";
import type {ChatGenerateParams,LlmProvider} from "../lib/providers/types";

const params:ChatGenerateParams={name:"Katie",persona:"Companion actor",summary:"",
  user:"Assess the image uploaded in the preceding turn.",history:[],
  requestIntent:"social-emotional",modelId:"claude-lead"};

const control=CAPABILITY_REQUEST_PREFIX+" "+JSON.stringify({
  task:"Inspect the exact image",capability:"vision",reason:"Need pixel evidence",
  preferredProvider:"google",context:"Current-chat user upload"
});
const prefaced="Fair — I should check the image instead of guessing.\n\n"+control;

test("a control request after ordinary prose is parsed, not mistaken for a finished response",()=>{
  const parsed=parseCapabilityEscalationRequest(prefaced);
  assert.equal(parsed?.task,"Inspect the exact image");
  assert.equal(parsed?.capability,"vision");
  assert.equal(parsed?.preferredProvider,"google");
  assert.equal(hasCapabilityEscalationMarker(prefaced),true);
  assert.equal(parseCapabilityEscalationRequest("A normal user-facing answer."),null);
});

test("streamed lead text cannot leak even when the model prepends a normal apology",async()=>{
  let visible="";
  const lead:LlmProvider={name:"anthropic",listModels:async()=>["claude-lead"],
    generate:async()=>({text:prefaced,provider:"anthropic",model:"claude-lead"}),
    generateStream:async(_p,h)=>{
      for(const piece of ["Fair — I should check the image instead of guessing.\n",
        "\nKATIE_CAPABILITY_","REQUEST: ",control.slice(CAPABILITY_REQUEST_PREFIX.length+1)]){
        await h.onTextDelta?.(piece);
      }
      return {text:prefaced,provider:"anthropic",model:"claude-lead"};
    }};
  const r=await runCapabilityAwareGeneration({provider:lead,params,onTextDelta:t=>{visible+=t;}});
  assert.equal(visible,"");
  assert.equal(r.escalationRequest?.capability,"vision");
  assert.equal(r.streamedText,"");
});

test("malformed control cannot be saved as successful user-facing content",async()=>{
  let visible="";
  const raw="I will check.\n"+CAPABILITY_REQUEST_PREFIX+" {broken-json";
  const lead:LlmProvider={name:"anthropic",listModels:async()=>["lead"],
    generate:async()=>({text:raw,provider:"anthropic",model:"lead"})};
  await assert.rejects(()=>runCapabilityAwareGeneration({provider:lead,params,onTextDelta:t=>{visible+=t;}}),
    /Malformed internal capability request/);
  assert.equal(visible,"");
  assert.equal(parseCapabilityEscalationRequest(raw),null);
});

test("runner delegates mid-message vision control and returns only completed final answer",async()=>{
  let passes=0,selected=0,visible="";
  const lead:LlmProvider={name:"anthropic",listModels:async()=>["claude-lead"],
    generate:async()=>({text:"unused",provider:"anthropic",model:"claude-lead"}),
    generateStream:async(_p,h)=>{
      const message=passes++===0?prefaced:"I see the saved image observation, and here is my visual assessment.";
      await h.onTextDelta?.(message);
      return {text:message,provider:"anthropic",model:"claude-lead"};
    }};
  const helper:LlmProvider={name:"google",listModels:async()=>["vision-model"],
    generate:async()=>({text:"Verified image shows a woman seated at a table.",provider:"google",model:"vision-model"})};
  const r=await runOnDemandCapabilityEscalation({
    requestId:"test-bounded-vision-escalation",leadProvider:lead,leadModelId:"claude-lead",params,
    selectHelper:async c=>{selected++;assert.equal(c.request.capability,"vision");return {provider:helper,modelId:"vision-model"};},
    onFinalTextDelta:t=>{visible+=t;}
  });
  assert.equal(selected,1);
  assert.equal(passes,2);
  assert.equal(r.result.text,visible);
  assert.match(visible,/visual assessment/);
  assert.doesNotMatch(visible,/KATIE_CAPABILITY_REQUEST/);
});
