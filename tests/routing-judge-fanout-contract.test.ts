import test, { mock } from "node:test";
import assert from "node:assert/strict";
import * as economics from "@/lib/router/control-plane-economics";
import { runWithStandaloneAccounting } from "@/lib/standalone-accounting/context";
import {
  buildCandidateMetadata, buildRoutingPreferenceProfile, chooseRoutingWithLLM,
} from "@/lib/router/model-intent";
import type { LlmProvider } from "@/lib/providers/types";

const owner = { userId: "routing-contract-owner", actorId: "routing-contract-actor",
  chatId: "routing-contract-chat", requestId: "routing-contract-request" };
const selected = { provider: "openai", model: "gpt-5.5-pro" };
const qualification = {
  required_quality: "Evaluate the complex current request accurately and preserve material context.",
  selected_fit: "Reported reasoning and long-context capabilities meet the material requirements.",
  evidence_basis_kind: "reasoned_inference",
  evidence_basis: "Reported model capabilities exist; no measured matched task outcome is available.",
  comparative_uncertainty: "Actual comparative quality remains unknown without direct outcomes.",
  cost_after_qualification: "Evaluate quoted prices only after confirming adequate quality.",
};
const correct = JSON.stringify({
  selected,
  selection_justification: "Complex request warrants deeper model reasoning, with unverified comparative outcomes.",
  alternatives: [{
    provider: "openai", model: "gpt-5.4",
    why_not_selected: "Lower expected cost but task-specific quality remains uncertain.",
  }],
  quality_qualification: qualification,
});
const historicalShape = JSON.stringify({
  selected,
  selection_justification: "Complex request warrants deeper model reasoning, with unverified comparative outcomes.",
  alternatives: [{
    provider: "openai", model: "gpt-5.4",
    why_not_selected: "Lower expected cost but task-specific quality remains uncertain.",
  }],
});

async function runJudges(judgeOutput: "one-valid" | "all-invalid") {
  const calls: Record<string, number> = {};
  const ranks = mock.method(economics, "rankControlPlaneByActualCost",
    async (list: unknown[]) => list);
  const judge = (name: LlmProvider["name"], modelId: string, response: "valid" | "invalid" | "timeout") => {
    const provider: LlmProvider = {
      name,
      listModels: async () => [modelId],
      generate: async (p) => {
        calls[name] = (calls[name] ?? 0) + 1;
        assert.match(p.user, /MANDATORY COMPLETE RESPONSE SHAPE/);
        assert.match(p.user, /quality_qualification/);
        if (response === "timeout") throw new Error("simulated provider timeout; no paid transmission");
        return { text: response === "valid" ? correct : historicalShape, provider: name,
          model: p.modelId! };
      },
    };
    return { provider, modelId };
  };
  const decisionProviders = [
    judge("openai", "gpt-4.1-mini", judgeOutput === "one-valid" ? "valid" : "invalid"),
    judge("anthropic", "claude-haiku-5-5", "timeout"),
    judge("google", "gemini-2.5-flash", judgeOutput === "one-valid" ? "timeout" : "invalid"),
  ];
  try {
    const result = await runWithStandaloneAccounting(owner, () => chooseRoutingWithLLM({
      routing_mode: "best_value",
      prompt: "Assess a complex, context-sensitive financial and operational strategy.",
      intent: "assistant-reflection",
      complexity: "high",
      modalityFlags: { has_images: false, has_video_input: false },
      hardRouteContext: { hard_rule_applied: false, rule: "none" },
      preferenceProfile: buildRoutingPreferenceProfile(),
      candidates: [
        buildCandidateMetadata("openai", "gpt-5.5-pro", "assistant-reflection"),
        buildCandidateMetadata("openai", "gpt-5.4", "assistant-reflection"),
      ],
      decisionProviders,
    }));
    return { result, calls };
  } finally {
    ranks.mock.restore();
  }
}

test("one valid judgment wins with two other judges timing out and no replay", async () => {
  const { result, calls } = await runJudges("one-valid");
  assert.equal(result.accepted, true);
  if (!result.accepted) assert.fail("the valid judge must survive other judge failures");
  assert.equal(result.selected.providerName, "openai");
  assert.equal(result.selected.modelId, "gpt-5.5-pro");
  assert.deepEqual(calls, { openai: 1, anthropic: 1, google: 1 },
    "no duplicate or unauthorized provider inference");
});

test("all incomplete/failed judgments retain existing safe fallback result", async () => {
  const { result, calls } = await runJudges("all-invalid");
  assert.equal(result.accepted, false);
  if (result.accepted) assert.fail("no invalid judge may determine the selection");
  assert.equal(result.reason, "all_decision_providers_failed");
  assert.deepEqual(calls, { openai: 1, anthropic: 1, google: 1 },
    "a rejected structured response must not cause any automatic replay");
});

/** Four independently qualified judges; the provider names cast votes but never
 * receive extra weight. No SDK/API transmission is made by these fixtures. */
async function fourJudgeBallot(grokTimesOut: boolean, priorForA: number, priorForB: number) {
  const calls: Record<string, number> = {};
  const prompts = new Map<string,string>();
  const seen: string[] = [];
  let resolveAll!: () => void;
  const allStarted = new Promise<void>(resolve => {resolveAll = resolve;});
  let release!: () => void;
  const barrier = new Promise<void>(resolve => {release = resolve;});
  const modelA={provider:"openai" as const,model:"gpt-5.5-pro"};
  const modelB={provider:"google" as const,model:"gemini-2.5-flash"};
  const ballot=(winner:typeof modelA | typeof modelB)=>JSON.stringify({
    selected:winner,
    selection_justification:"A candidate meets the mocked task requirements; actual comparative outcomes remain unknown.",
    alternatives:[{...(winner.model===modelA.model?modelB:modelA),
      why_not_selected:"Existing model evidence and prior score decide this fixture without giving judge providers preference."}],
    quality_qualification:qualification,
  });
  const decisions=[
    {name:"openai" as const,model:"gpt-4.1-mini",choice:modelA},
    {name:"anthropic" as const,model:"claude-haiku-5-5",choice:modelA},
    {name:"google" as const,model:"gemini-2.5-flash",choice:modelB},
    {name:"grok" as const,model:"grok-4.3",choice:modelB},
  ];
  const providers = decisions.map(judge=>({
    provider: {
      name:judge.name,
      listModels:async()=>[judge.model],
      generate:async (params:import("@/lib/providers/types").ChatGenerateParams)=>{
        calls[judge.name]=(calls[judge.name]??0)+1;
        seen.push(judge.name);
        prompts.set(judge.name,params.user);
        assert.equal(params.modelId,judge.model);
        if(seen.length===4) resolveAll();
        await barrier;
        if(judge.name==="grok"&&grokTimesOut)
          throw Object.assign(new Error("Simulated unknown helper timeout; never retry"),{code:"standalone_outcome_unknown"});
        return {text:ballot(judge.choice),provider:judge.name,model:judge.model};
      },
    } as LlmProvider,
    modelId:judge.model,
  }));
  const ranked = mock.method(economics,"rankControlPlaneByActualCost",
    async(list:unknown[])=>list);
  try{
    const running=runWithStandaloneAccounting(owner,()=>chooseRoutingWithLLM({
      routing_mode:"best_value",prompt:"Select a compatible model for a grounded text response",
      intent:"general-text",complexity:"low",
      modalityFlags:{has_images:false,has_video_input:false},
      hardRouteContext:{hard_rule_applied:false,rule:"none"},
      preferenceProfile:buildRoutingPreferenceProfile(),
      candidates:[
        {...buildCandidateMetadata(modelA.provider,modelA.model,"general-text"),prior_score:priorForA},
        {...buildCandidateMetadata(modelB.provider,modelB.model,"general-text"),prior_score:priorForB},
      ],
      decisionProviders:providers,
    }));
    // The four provider calls must all start before any one of them finishes.
    await Promise.race([allStarted,new Promise<never>((_,reject)=>
      setTimeout(()=>reject(new Error("Four judges did not launch in parallel")),5000))]);
    release();
    const result=await running;
    return {result,calls,prompts,seen};
  }finally{release();ranked.mock.restore();}
}

test("four-judge Grok vote: simultaneous identical payloads, valid JSON and an evidence-ranked 2–2 tie",async()=>{
  const {result,calls,prompts,seen}=await fourJudgeBallot(false,0,8);
  assert.equal(result.accepted,true);
  if(!result.accepted) assert.fail("Valid Grok 4.3 and other judgments must be accepted");
  assert.equal(result.selected.modelId,"gemini-2.5-flash",
    "A 2–2 split is resolved by existing candidate evidence/ranking, not the judge provider");
  assert.deepEqual(seen.sort(),["anthropic","google","grok","openai"]);
  assert.equal(new Set(prompts.values()).size,1,"identical instructions, candidate inventory and quality evidence");
  assert.deepEqual(calls,{openai:1,anthropic:1,google:1,grok:1},
    "each judge receives precisely one independent attempt");
  const reversed=await fourJudgeBallot(false,8,0);
  assert.equal(reversed.result.accepted,true);
  if(!reversed.result.accepted) assert.fail("A qualifying tied judgment must be accepted");
  assert.equal(reversed.result.selected.modelId,"gpt-5.5-pro",
    "changing evidence/ranking changes the tie winner without weighting Grok or another judge");
});

test("one failed Grok judge does not block three independent valid votes or replay inference",async()=>{
  const {result,calls,prompts}=await fourJudgeBallot(true,0,8);
  assert.equal(result.accepted,true);
  if(!result.accepted) assert.fail("Three valid judges must survive an unavailable Grok");
  assert.equal(result.selected.modelId,"gpt-5.5-pro","existing 2–1 majority wins without Grok");
  assert.equal(new Set(prompts.values()).size,1);
  assert.deepEqual(calls,{openai:1,anthropic:1,google:1,grok:1},
    "a failed judge never triggers a duplicate paid call");
});
