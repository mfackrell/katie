import test, { mock } from "node:test";
import assert from "node:assert/strict";
import * as economics from "@/lib/router/control-plane-economics";
import { runWithStandaloneAccounting } from "@/lib/standalone-accounting/context";
import { inferRequestClassificationWithSource } from "@/lib/router/model-intent";
import type { LlmProvider } from "@/lib/providers/types";

const owner = { userId:"owner-test", actorId:"actor-test", chatId:"chat-test", requestId:"request-test" };

test('first classifier response with apostrophe typography drift is accepted without a second paid call', async () => {
  const rank = mock.method(economics, 'rankControlPlaneByActualCost', async (candidates: unknown[]) => candidates);
  const message = "You're reviewing Katie’s forecast, aren’t you?";
  let calls = 0;
  const provider: LlmProvider = {
    name: 'openai',
    listModels: async () => ['gpt-5.4'],
    generate: async params => {
      calls++;
      assert.equal(params.user.includes('CORRECTION:'), false, 'a complete first result must not trigger correction');
      return {text: JSON.stringify({
        intent:'general-text', secondary_intents:[], complexity:'medium',
        provider_refusal_risk:'low', preferred_provider:null, response_purpose:'conversation',
        primary_objective:'Confirm the forecast review request',
        quality_requirements:'Accurate financial context and a direct response',
        objective_evidence:[message.replaceAll("’", "'")],
        context_influence:'Ongoing forecast discussion',
        selection_justification:'The request is a contextual financial conversation'
      }),provider:'openai',model:params.modelId!};
    }
  };
  try {
    const result = await runWithStandaloneAccounting(owner, () =>
      inferRequestClassificationWithSource(message, false, {
        decisionProviders:[{provider,modelId:'gpt-5.4'}],
      })
    );
    assert.equal(calls,1,'saved first-pass answer should be enough');
    assert.equal(result.source,'llm');
    assert.equal(result.classification.intent,'general-text');
    assert.deepEqual(result.classification.decisionEvidence?.objective_evidence,[message],
      'the quote handed to the model router must be exact original source characters');
  } finally {rank.mock.restore();}
});
