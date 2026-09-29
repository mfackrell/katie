import test from "node:test";
import assert from "node:assert/strict";
import { shouldUseAdaptiveCollaboration } from "../lib/collaboration/activation";
import { runAdaptiveCollaboration } from "../lib/collaboration/orchestrator";
import {
  parseHelperControlDecision,
  parseLeadControlDecision,
} from "../lib/collaboration/protocol";
import type { CollaborationHelperSelection } from "../lib/collaboration/types";
import type {
  ChatGenerateParams,
  LlmProvider,
  ProviderResponse,
  ProviderStreamHandlers,
} from "../lib/providers/types";

type FakeProviderOptions = {
  name: LlmProvider["name"];
  modelId: string;
  controlResponses: string[];
  finalText?: string;
};

function fakeProvider(options: FakeProviderOptions): LlmProvider & {
  calls: ChatGenerateParams[];
} {
  const calls: ChatGenerateParams[] = [];
  let controlIndex = 0;

  return {
    name: options.name,
    calls,
    async listModels() {
      return [options.modelId];
    },
    async generate(params) {
      calls.push(params);
      const text = options.controlResponses[controlIndex] ?? "";
      controlIndex += 1;
      return {
        text,
        provider: options.name,
        model: params.modelId ?? options.modelId,
      } satisfies ProviderResponse;
    },
    async generateStream(
      params: ChatGenerateParams,
      handlers: ProviderStreamHandlers,
    ) {
      calls.push(params);
      const text = options.finalText ?? "final";
      await handlers.onTextDelta?.(text);
      return {
        text,
        provider: options.name,
        model: params.modelId ?? options.modelId,
      } satisfies ProviderResponse;
    },
  };
}

const baseParams: ChatGenerateParams = {
  name: "Katie",
  persona: "Be precise.",
  summary: "Shared memory.",
  history: [],
  user: "Solve the difficult problem comprehensively.",
  requestIntent: "architecture-review",
  modelId: "lead-model",
};

test("collaboration protocol parses lead/helper control JSON", () => {
  const lead = parseLeadControlDecision(
    JSON.stringify({
      action: "delegate",
      request: {
        task: "Check the architecture",
        capability: "architecture",
        reason: "Independent review",
        preferredProvider: "anthropic",
      },
    }),
  );
  assert.equal(lead?.action, "delegate");
  if (lead?.action === "delegate") {
    assert.equal(lead.request.capability, "architecture");
    assert.equal(lead.request.preferredProvider, "anthropic");
  }

  const helper = parseHelperControlDecision(
    ```json
{"action":"answer","answer":"Looks sound","confidence":"high","caveats":["Check timeout"]}
```,
  );
  assert.equal(helper?.action, "answer");
  if (helper?.action === "answer") {
    assert.equal(helper.answer, "Looks sound");
    assert.deepEqual(helper.caveats, ["Check timeout"]);
  }
});

test("activation keeps simple chat fast but enables complex and explicit collaboration", () => {
  assert.equal(
    shouldUseAdaptiveCollaboration({
      message: "hello",
      intent: "general-text",
      complexity: "low",
    }),
    false,
  );

  assert.equal(
    shouldUseAdaptiveCollaboration({
      message: "Review this architecture comprehensively",
      intent: "architecture-review",
      complexity: "high",
    }),
    true,
  );

  assert.equal(
    shouldUseAdaptiveCollaboration({
      message: "Have the models work together on this",
      intent: "general-text",
      complexity: "low",
      hasManualOverride: true,
    }),
    true,
  );

  assert.equal(
    shouldUseAdaptiveCollaboration({
      message: "Use Claude only for this answer",
      intent: "general-text",
      complexity: "high",
      hasManualOverride: true,
    }),
    false,
  );
});

test("lead dynamically delegates to a helper and synthesizes one final answer", async () => {
  const lead = fakeProvider({
    name: "openai",
    modelId: "lead-model",
    controlResponses: [
      JSON.stringify({
        action: "delegate",
        request: {
          task: "Independently verify the proposed architecture.",
          capability: "verification",
          reason: "Need an independent check.",
          preferredProvider: "anthropic",
        },
      }),
      JSON.stringify({
        action: "ready",
        synthesisBrief: "Use the independent verification and answer completely.",
      }),
    ],
    finalText: "Final synthesized answer.",
  });

  const helper = fakeProvider({
    name: "anthropic",
    modelId: "helper-model",
    controlResponses: [
      JSON.stringify({
        action: "answer",
        answer: "The architecture is sound but add a recursion limit.",
        confidence: "high",
      }),
    ],
  });

  const selections: string[] = [];
  let streamed = "";

  const result = await runAdaptiveCollaboration({
    requestId: "req-basic",
    leadProvider: lead,
    leadModelId: "lead-model",
    providers: [lead, helper],
    params: baseParams,
    async selectHelper(context): Promise<CollaborationHelperSelection> {
      selections.push(context.request.task);
      return {
        provider: helper,
        modelId: "helper-model",
        reasoning: "Independent provider selected.",
      };
    },
    async onFinalTextDelta(delta) {
      streamed += delta;
    },
  });

  assert.equal(selections.length, 1);
  assert.equal(result.result.text, "Final synthesized answer.");
  assert.equal(streamed, "Final synthesized answer.");
  assert.equal(result.metadata.used, true);
  assert.equal(result.metadata.delegationCount, 1);
  assert.equal(result.metadata.contributors[0]?.provider, "anthropic");
  assert.equal(result.metadata.contributions[0]?.capability, "verification");
  assert.match(
    lead.calls.at(-1)?.user ?? "",
    /The architecture is sound but add a recursion limit/,
  );
});

test("a helper can recursively request another model before answering the lead", async () => {
  const lead = fakeProvider({
    name: "openai",
    modelId: "lead",
    controlResponses: [
      JSON.stringify({
        action: "delegate",
        request: {
          task: "Review the implementation plan.",
          capability: "architecture",
        },
      }),
      JSON.stringify({
        action: "ready",
        synthesisBrief: "Incorporate the architecture review.",
      }),
    ],
    finalText: "Nested collaboration final.",
  });

  const helperA = fakeProvider({
    name: "anthropic",
    modelId: "helper-a",
    controlResponses: [
      JSON.stringify({
        action: "delegate",
        request: {
          task: "Check the database concurrency assumptions.",
          capability: "verification",
        },
      }),
      JSON.stringify({
        action: "answer",
        answer: "Architecture review complete; concurrency concern was checked.",
        confidence: "high",
      }),
    ],
  });

  const helperB = fakeProvider({
    name: "google",
    modelId: "helper-b",
    controlResponses: [
      JSON.stringify({
        action: "answer",
        answer: "The concurrency assumption needs transaction serialization.",
        confidence: "medium",
      }),
    ],
  });

  const result = await runAdaptiveCollaboration({
    requestId: "req-nested",
    leadProvider: lead,
    leadModelId: "lead",
    providers: [lead, helperA, helperB],
    params: baseParams,
    maxDepth: 2,
    maxDelegations: 5,
    async selectHelper(context) {
      if (context.depth === 1) {
        return { provider: helperA, modelId: "helper-a" };
      }
      return { provider: helperB, modelId: "helper-b" };
    },
  });

  assert.equal(result.result.text, "Nested collaboration final.");
  assert.equal(result.metadata.delegationCount, 2);
  assert.equal(result.metadata.maxDepthReached, 2);
  assert.equal(result.metadata.contributors.length, 2);
  assert.equal(helperA.calls.length, 2);
  assert.match(
    helperA.calls[1]?.user ?? "",
    /transaction serialization/,
  );
});

test("failed helper is automatically rerouted without another lead control pass", async () => {
  const lead = fakeProvider({
    name: "anthropic",
    modelId: "lead",
    controlResponses: [
      JSON.stringify({
        action: "delegate",
        request: {
          task: "Challenge the explanation.",
          capability: "critique",
        },
      }),
      JSON.stringify({
        action: "ready",
        synthesisBrief: "Use the successful replacement critique.",
      }),
    ],
    finalText: "Replacement helper synthesis.",
  });

  const failedHelper = fakeProvider({
    name: "google",
    modelId: "failed-helper",
    controlResponses: [""],
  });

  const replacementHelper = fakeProvider({
    name: "openai",
    modelId: "replacement-helper",
    controlResponses: [
      JSON.stringify({
        action: "answer",
        answer: "Independent critique completed.",
        confidence: "high",
      }),
    ],
  });

  let selectionCount = 0;
  const result = await runAdaptiveCollaboration({
    requestId: "req-helper-reroute",
    leadProvider: lead,
    leadModelId: "lead",
    providers: [lead, failedHelper, replacementHelper],
    params: baseParams,
    maxDelegations: 3,
    async selectHelper() {
      selectionCount += 1;
      return selectionCount === 1
        ? { provider: failedHelper, modelId: "failed-helper" }
        : { provider: replacementHelper, modelId: "replacement-helper" };
    },
  });

  assert.equal(selectionCount, 2);
  assert.equal(result.metadata.delegationCount, 1);
  assert.equal(result.metadata.contributors.length, 1);
  assert.equal(result.metadata.contributors[0]?.modelId, "replacement-helper");
  assert.equal(
    result.trace.some((event) => event.type === "helper_retrying"),
    true,
  );
  assert.equal(lead.calls.length, 3);
  assert.equal(result.result.text, "Replacement helper synthesis.");
});

test("helper failure is non-fatal and lead still produces the answer", async () => {
  const lead = fakeProvider({
    name: "openai",
    modelId: "lead",
    controlResponses: [
      JSON.stringify({
        action: "delegate",
        request: {
          task: "Verify this claim.",
          capability: "verification",
        },
      }),
      JSON.stringify({
        action: "ready",
        synthesisBrief: "Helper unavailable; solve directly.",
      }),
    ],
    finalText: "Lead recovered and answered.",
  });

  const result = await runAdaptiveCollaboration({
    requestId: "req-helper-fail",
    leadProvider: lead,
    leadModelId: "lead",
    providers: [lead],
    params: baseParams,
    async selectHelper() {
      return null;
    },
  });

  assert.equal(result.result.text, "Lead recovered and answered.");
  assert.equal(result.metadata.delegationCount, 1);
  assert.equal(result.metadata.contributors.length, 0);
  assert.equal(result.trace.some((event) => event.type === "helper_failed"), true);
});

test("delegation budget prevents unbounded model meetings", async () => {
  const lead = fakeProvider({
    name: "openai",
    modelId: "lead",
    controlResponses: [
      JSON.stringify({
        action: "delegate",
        request: { task: "Ask one", capability: "analysis" },
      }),
      JSON.stringify({
        action: "delegate",
        request: { task: "Ask two", capability: "critique" },
      }),
    ],
    finalText: "Budget-bounded final.",
  });

  const helper = fakeProvider({
    name: "anthropic",
    modelId: "helper",
    controlResponses: [
      JSON.stringify({
        action: "answer",
        answer: "First contribution.",
      }),
    ],
  });

  const result = await runAdaptiveCollaboration({
    requestId: "req-budget",
    leadProvider: lead,
    leadModelId: "lead",
    providers: [lead, helper],
    params: baseParams,
    maxDelegations: 1,
    async selectHelper() {
      return { provider: helper, modelId: "helper" };
    },
  });

  assert.equal(result.metadata.delegationCount, 1);
  assert.equal(result.result.text, "Budget-bounded final.");
  assert.equal(result.trace.some((event) => event.type === "limit_reached"), true);
});

test("lead can decide no helper is needed", async () => {
  const lead = fakeProvider({
    name: "google",
    modelId: "lead",
    controlResponses: [
      JSON.stringify({
        action: "ready",
        synthesisBrief: "This is straightforward; answer directly.",
      }),
    ],
    finalText: "Direct final answer.",
  });

  let helperSelections = 0;
  const result = await runAdaptiveCollaboration({
    requestId: "req-direct",
    leadProvider: lead,
    leadModelId: "lead",
    providers: [lead],
    params: baseParams,
    async selectHelper() {
      helperSelections += 1;
      return null;
    },
  });

  assert.equal(helperSelections, 0);
  assert.equal(result.metadata.used, false);
  assert.equal(result.result.text, "Direct final answer.");
});
