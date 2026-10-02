import test from "node:test";
import assert from "node:assert/strict";
import { shouldUseAdaptiveCollaboration } from "../lib/collaboration/activation";
import { runAdaptiveCollaboration } from "../lib/collaboration/orchestrator";
import { selectCollaborationHelper } from "../lib/collaboration/routing";
import {
  CAPABILITY_REQUEST_PREFIX,
  getCapabilityEscalationInstruction,
  parseCapabilityEscalationRequest,
} from "../lib/collaboration/capability-escalation";
import { runOnDemandCapabilityEscalation } from "../lib/collaboration/capability-escalation-runner";
import {
  parseHelperControlDecision,
  parseLeadControlDecision,
} from "../lib/collaboration/protocol";
import type { CollaborationHelperSelection, CollaborationResumeState } from "../lib/collaboration/types";
import type {
  ChatGenerateParams,
  LlmProvider,
  ProviderResponse,
  ProviderStreamHandlers,
  WebsiteEvidence,
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
    '```json\n{"action":"answer","answer":"Looks sound","confidence":"high","caveats":["Check timeout"]}\n```',
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
      message: "Review this live website from a marketing perspective",
      intent: "marketing-analysis",
      complexity: "medium",
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

test("capability escalation forbids asking permission before useful live research", async () => {
  const instruction = getCapabilityEscalationInstruction();

  assert.match(instruction, /use it autonomously/i);
  assert.match(instruction, /DO NOT ask whether the user wants you to search/i);
  assert.match(instruction, /do the search now instead/i);

  let receivedPersona = "";
  const lead: LlmProvider = {
    name: "anthropic",
    async listModels() {
      return ["claude-lead"];
    },
    async generate(params) {
      receivedPersona = params.persona;
      return {
        text: "Normal answer.",
        provider: "anthropic",
        model: params.modelId ?? "claude-lead",
      };
    },
    async generateStream(params, handlers) {
      receivedPersona = params.persona;
      await handlers.onTextDelta?.("Normal answer.");
      return {
        text: "Normal answer.",
        provider: "anthropic",
        model: params.modelId ?? "claude-lead",
      };
    },
  };

  await runOnDemandCapabilityEscalation({
    collectWebsiteEvidence: async () => undefined,
    requestId: "req-autonomous-research-instruction",
    leadProvider: lead,
    leadModelId: "claude-lead",
    params: {
      ...baseParams,
      user: "Give me a useful answer.",
      requestIntent: "general-text",
      modelId: "claude-lead",
    },
    async selectHelper() {
      throw new Error("helper should not be selected for a normal answer");
    },
    async onFinalTextDelta() {},
  });

  assert.match(receivedPersona, /use it autonomously/i);
  assert.match(
    receivedPersona,
    /DO NOT ask whether the user wants you to search/i,
  );
});

test("capability request parser defaults live research to Grok", () => {
  const request = parseCapabilityEscalationRequest(
    CAPABILITY_REQUEST_PREFIX +
      ' {"task":"Check https://example.com live","capability":"research","reason":"Need current website state","preferredProvider":null}',
  );

  assert.equal(request?.capability, "research");
  assert.equal(request?.preferredProvider, "grok");
  assert.match(request?.task ?? "", /example\.com/);
});

test("single-model lead escalates live research to a helper and then resumes", async () => {
  const leadCalls: ChatGenerateParams[] = [];
  let leadPass = 0;
  const lead: LlmProvider = {
    name: "anthropic",
    async listModels() {
      return ["claude-lead"];
    },
    async generate(params) {
      leadCalls.push(params);
      return {
        text: "",
        provider: "anthropic",
        model: params.modelId ?? "claude-lead",
      };
    },
    async generateStream(params, handlers) {
      leadCalls.push(params);
      leadPass += 1;
      const text =
        leadPass === 1
          ? CAPABILITY_REQUEST_PREFIX +
            ' {"task":"Inspect https://c3execs.com/ and report the current homepage state","capability":"research","reason":"The answer benefits from current site verification","preferredProvider":"grok"}'
          : "Final answer using the live website evidence.";
      await handlers.onTextDelta?.(text);
      return {
        text,
        provider: "anthropic",
        model: params.modelId ?? "claude-lead",
      };
    },
  };

  const helperCalls: ChatGenerateParams[] = [];
  const helper: LlmProvider = {
    name: "grok",
    async listModels() {
      return ["grok-web"];
    },
    async generate(params) {
      helperCalls.push(params);
      return {
        text: "Live check: the current homepage is updated.",
        provider: "grok",
        model: params.modelId ?? "grok-web",
      };
    },
  };

  let visibleText = "";
  const result = await runOnDemandCapabilityEscalation({
    collectWebsiteEvidence: async () => undefined,
    requestId: "req-capability-escalation",
    leadProvider: lead,
    leadModelId: "claude-lead",
    params: {
      ...baseParams,
      user: "What am I really building with C3?",
      requestIntent: "social-emotional",
      modelId: "claude-lead",
    },
    async selectHelper(context) {
      assert.equal(context.request.capability, "research");
      assert.equal(context.request.preferredProvider, "grok");
      return {
        provider: helper,
        modelId: "grok-web",
      };
    },
    async onFinalTextDelta(delta) {
      visibleText += delta;
    },
  });

  assert.equal(helperCalls.length, 1);
  assert.equal(helperCalls[0]?.requestIntent, "web-search");
  assert.match(helperCalls[0]?.user ?? "", /c3execs\.com/);
  assert.equal(leadCalls.length, 2);
  assert.match(leadCalls[1]?.user ?? "", /current homepage is updated/);
  assert.equal(
    visibleText,
    "Final answer using the live website evidence.",
  );
  assert.equal(result.result.model, "claude-lead");
  assert.equal(result.result.collaboration?.delegationCount, 1);
  assert.equal(
    result.result.collaboration?.contributors[0]?.provider,
    "grok",
  );
  assert.equal(
    result.trace.some((event) => event.type === "helper_completed"),
    true,
  );
});

test("marketing analysis gathers live web evidence and shares it with an independent reviewer", async () => {
  const lead = fakeProvider({
    name: "anthropic",
    modelId: "claude-marketing",
    controlResponses: [
      JSON.stringify({
        action: "delegate",
        request: {
          task: "Fetch the same website again before I synthesize.",
          capability: "research",
          reason: "Double-check the current page.",
        },
      }),
      JSON.stringify({
        action: "ready",
        synthesisBrief: "Use the live evidence and independent critique.",
      }),
    ],
    finalText: "Final marketing review.",
  });

  const research = fakeProvider({
    name: "grok",
    modelId: "grok-web",
    controlResponses: [
      JSON.stringify({
        action: "answer",
        answer:
          "Observed homepage evidence: headline says Interim executives. Primary CTA says Talk to an operator.",
        confidence: "high",
      }),
    ],
  });
  const originalResearchGenerate = research.generate.bind(research);
  research.generate = async (params) => {
    const response = await originalResearchGenerate(params);
    return {
      ...response,
      researchEvidence: {
        kind: "web",
        retrievedBy: { provider: "grok", modelId: "grok-web" },
        query: params.user,
        summary: response.text,
        sources: [
          {
            url: "https://c3execs.com/",
            title: "C3 Executive Suite",
            snippet: "Interim executives. Talk to an operator.",
          },
        ],
        retrievedAt: "2026-09-30T00:00:00.000Z",
      },
    };
  };

  const reviewer = fakeProvider({
    name: "openai",
    modelId: "gpt-reviewer",
    controlResponses: [
      JSON.stringify({
        action: "answer",
        answer:
          "Independent critique: the operator CTA is credible, but the headline should state the buyer outcome more explicitly.",
        confidence: "high",
      }),
    ],
  });

  const selectedCapabilities: string[] = [];
  const result = await runAdaptiveCollaboration({
    collectWebsiteEvidence: async () => undefined,
    requestId: "req-marketing-evidence",
    leadProvider: lead,
    leadModelId: "claude-marketing",
    providers: [lead, research, reviewer],
    params: {
      ...baseParams,
      user: "Review this site from a marketing perspective: https://c3execs.com/",
      requestIntent: "marketing-analysis",
      secondaryIntents: ["web-search"],
      modelId: "claude-marketing",
    },
    async selectHelper(context) {
      selectedCapabilities.push(context.request.capability);
      if (context.request.capability === "research") {
        return {
          provider: research,
          modelId: "grok-web",
          reasoning: "Web-capable retrieval specialist.",
        };
      }
      return {
        provider: reviewer,
        modelId: "gpt-reviewer",
        reasoning: "Independent cross-provider marketing critique.",
      };
    },
  });

  assert.deepEqual(selectedCapabilities, ["research", "critique"]);
  assert.equal(research.calls.length, 1);
  assert.equal(research.calls[0]?.requestIntent, "web-search");
  assert.match(research.calls[0]?.user ?? "", /Open and inspect the relevant live URL/i);
  assert.match(reviewer.calls[0]?.user ?? "", /https:\/\/c3execs\.com\//);
  assert.match(reviewer.calls[0]?.user ?? "", /Interim executives/);
  assert.match(lead.calls[0]?.user ?? "", /Observed homepage evidence/);
  assert.match(lead.calls[0]?.user ?? "", /Independent critique/);
  assert.equal(result.metadata.contributors.length, 2);
  assert.equal(result.metadata.contributors[0]?.provider, "grok");
  assert.equal(result.metadata.contributors[1]?.provider, "openai");
  assert.equal(
    result.trace.some((event) => event.type === "research_evidence_collected"),
    true,
  );
  assert.equal(
    result.trace.some((event) => event.type === "research_evidence_reused"),
    true,
  );
  assert.equal(result.result.text, "Final marketing review.");
});

test("lead-requested research still triggers the independent marketing critique", async () => {
  const lead = fakeProvider({
    name: "anthropic",
    modelId: "claude-marketing",
    controlResponses: [
      JSON.stringify({
        action: "delegate",
        request: {
          task: "Retrieve the current website so I can review it.",
          capability: "research",
          reason: "Fresh source material is required.",
        },
      }),
      JSON.stringify({
        action: "ready",
        synthesisBrief: "Use the retrieved evidence and critique.",
      }),
    ],
    finalText: "Final review after recovered research.",
  });

  const research = fakeProvider({
    name: "grok",
    modelId: "grok-web",
    controlResponses: ["Observed live homepage and CTA evidence."],
  });
  const originalResearchGenerate = research.generate.bind(research);
  research.generate = async (params) => {
    const response = await originalResearchGenerate(params);
    return {
      ...response,
      researchEvidence: {
        kind: "web",
        retrievedBy: { provider: "grok", modelId: "grok-web" },
        query: params.user,
        summary: response.text,
        sources: [{ url: "https://c3execs.com/", title: "C3 Executive Suite" }],
        retrievedAt: "2026-09-30T00:00:00.000Z",
      },
    };
  };

  const reviewer = fakeProvider({
    name: "openai",
    modelId: "gpt-reviewer",
    controlResponses: [
      JSON.stringify({
        action: "answer",
        answer: "Independent critique completed from the live evidence.",
        confidence: "high",
      }),
    ],
  });

  const selectedCapabilities: string[] = [];
  let forcedResearchAttempted = false;
  const result = await runAdaptiveCollaboration({
    collectWebsiteEvidence: async () => undefined,
    requestId: "req-marketing-recovered-research",
    leadProvider: lead,
    leadModelId: "claude-marketing",
    providers: [lead, research, reviewer],
    params: {
      ...baseParams,
      user: "Check the live site again: https://c3execs.com/",
      requestIntent: "marketing-analysis",
      secondaryIntents: ["web-search"],
      modelId: "claude-marketing",
    },
    async selectHelper(context) {
      selectedCapabilities.push(context.request.capability);
      if (context.request.capability === "research" && !forcedResearchAttempted) {
        forcedResearchAttempted = true;
        return null;
      }
      if (context.request.capability === "research") {
        return { provider: research, modelId: "grok-web" };
      }
      return { provider: reviewer, modelId: "gpt-reviewer" };
    },
  });

  assert.deepEqual(selectedCapabilities, ["research", "research", "critique"]);
  assert.equal(research.calls.length, 1);
  assert.equal(reviewer.calls.length, 1);
  assert.equal(
    result.metadata.contributions.some((entry) => entry.capability === "research"),
    true,
  );
  assert.equal(
    result.metadata.contributions.some((entry) => entry.capability === "critique"),
    true,
  );
  assert.equal(result.result.text, "Final review after recovered research.");
});

test("empty helper candidate pools return null without an undefined-provider crash", async () => {
  const onlyWebModel = fakeProvider({
    name: "openai",
    modelId: "gpt-5-search-api",
    controlResponses: [],
  });

  const selected = await selectCollaborationHelper({
    requestId: "req-empty-helper-pool",
    request: {
      task: "Fetch the live site.",
      capability: "research",
    },
    requester: { provider: "anthropic", modelId: "claude-marketing" },
    providers: [onlyWebModel],
    usedParticipants: [
      { provider: "openai", modelId: "gpt-5-search-api" },
    ],
  });

  assert.equal(selected, null);
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
    collectWebsiteEvidence: async () => undefined,
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
    collectWebsiteEvidence: async () => undefined,
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
    collectWebsiteEvidence: async () => undefined,
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
    collectWebsiteEvidence: async () => undefined,
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
    collectWebsiteEvidence: async () => undefined,
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

test("final synthesis fails over to a replacement lead without losing helper evidence", async () => {
  const leadCalls: ChatGenerateParams[] = [];
  let leadControlIndex = 0;
  const failingLead: LlmProvider & { calls: ChatGenerateParams[] } = {
    name: "openai",
    calls: leadCalls,
    async listModels() {
      return ["failing-lead"];
    },
    async generate(params) {
      leadCalls.push(params);
      const responses = [
        JSON.stringify({
          action: "delegate",
          request: {
            task: "Independently review the architecture.",
            capability: "architecture",
          },
        }),
        JSON.stringify({
          action: "ready",
          synthesisBrief: "Use the architecture review.",
        }),
      ];
      const text = responses[leadControlIndex] ?? "";
      leadControlIndex += 1;
      return {
        text,
        provider: "openai",
        model: params.modelId ?? "failing-lead",
      };
    },
    async generateStream() {
      throw new Error("429 You have no credits remaining.");
    },
  };

  const helper = fakeProvider({
    name: "anthropic",
    modelId: "architecture-helper",
    controlResponses: [
      JSON.stringify({
        action: "answer",
        answer: "Preserved helper evidence: split orchestration from request lifecycle.",
        confidence: "high",
      }),
    ],
  });

  const replacement = fakeProvider({
    name: "google",
    modelId: "replacement-lead",
    controlResponses: [],
    finalText: "Replacement synthesis used preserved evidence.",
  });

  let helperSelectionCount = 0;
  let replacementSelections = 0;

  const result = await runAdaptiveCollaboration({
    collectWebsiteEvidence: async () => undefined,
    requestId: "req-lead-failover",
    leadProvider: failingLead,
    leadModelId: "failing-lead",
    providers: [failingLead, helper, replacement],
    params: baseParams,
    async selectHelper() {
      helperSelectionCount += 1;
      return { provider: helper, modelId: "architecture-helper" };
    },
    async selectReplacementLead(context) {
      replacementSelections += 1;
      assert.equal(context.failedLead.provider, "openai");
      assert.equal(context.contributions.length, 1);
      assert.match(
        context.contributions[0]?.answer ?? "",
        /Preserved helper evidence/,
      );
      return {
        provider: replacement,
        modelId: "replacement-lead",
        reasoning: "Cross-provider replacement after lead failure.",
      };
    },
  });

  assert.equal(helperSelectionCount, 1);
  assert.equal(replacementSelections, 1);
  assert.equal(result.result.provider, "google");
  assert.equal(result.result.model, "replacement-lead");
  assert.equal(result.result.text, "Replacement synthesis used preserved evidence.");
  assert.equal(
    result.trace.some((event) => event.type === "lead_failed"),
    true,
  );
  assert.equal(
    result.trace.some((event) => event.type === "lead_replaced"),
    true,
  );

  const replacementFinalPrompt = replacement.calls.at(-1)?.user ?? "";
  assert.match(replacementFinalPrompt, /Preserved helper evidence/);
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
    collectWebsiteEvidence: async () => undefined,
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

const capturedWebsite: WebsiteEvidence = {
  capturedAt: "2026-10-01T00:00:00Z", limitations: [], pages: [{
    requestedUrl: "https://c3execs.com/", url: "https://c3execs.com/", title: "C3",
    html: '<section id="hero"><button>Book a call</button></section>', htmlTruncated: false,
    stylesheets: [{ url: "https://c3execs.com/style.css", css: "button {color: blue}", truncated: false }],
    limitations: [], views: [{ device: "desktop", viewport: { width: 1440, height: 900 },
      document: { width: 1440, height: 2000, horizontalOverflow: false }, text: "Book a call",
      elements: [], images: [], limitations: [],
      screenshot: { dataUrl: "data:image/png;base64,cHJlc2VydmVk", width: 1440, height: 900, truncated: false },
    }],
  }],
};
const marketingParams = { ...baseParams, user: "Review https://c3execs.com/", requestIntent: "marketing-analysis",
  secondaryIntents: ["web-search"], summary: "C3 is a broader executive firm built around three operators." };

function reviewHelpers() {
  return {
    research: fakeProvider({ name: "grok", modelId: "research", controlResponses: ["Verified website evidence: Book a call."] }),
    reviewer: fakeProvider({ name: "openai", modelId: "reviewer", controlResponses: [JSON.stringify({ action: "answer", answer: "Independent critique: keep the broader executive firm positioning." })] }),
  };
}

test("170-second research plus 110-second critique retains evidence and still leaves room for lead control", async (t) => {
  let clock = 0;
  t.mock.method(Date, "now", () => clock);
  const lead = fakeProvider({ name: "anthropic", modelId: "lead", controlResponses: [], finalText: "Review completed." });
  const { research, reviewer } = reviewHelpers();
  const originalResearch = research.generate.bind(research);
  research.generate = async (params) => { clock += 170_000; return originalResearch(params); };
  const originalReview = reviewer.generate.bind(reviewer);
  reviewer.generate = async (params) => { clock += 110_000; return originalReview(params); };
  let captures = 0;
  const result = await runAdaptiveCollaboration({ requestId: "slow-review", leadProvider: lead, leadModelId: "lead",
    providers: [lead, research, reviewer], params: marketingParams,
    collectWebsiteEvidence: async () => { captures++; return capturedWebsite; },
    selectHelper: async ({ request }) => request.capability === "research" ? { provider: research, modelId: "research" } : { provider: reviewer, modelId: "reviewer" },
  });
  assert.equal(lead.calls.length, 2, "lead control and final synthesis both have enough time");
  assert.equal(research.calls.length, 1);
  assert.equal(reviewer.calls.length, 1);
  assert.equal(captures, 1);
  assert.equal(result.metadata.delegationCount, 2);
  const finalCall = lead.calls.at(-1)!;
  assert.match(finalCall.user, /Verified website evidence/);
  assert.match(finalCall.user, /Independent critique/);
  assert.match(finalCall.user, /button \{color: blue\}/);
  assert.deepEqual(finalCall.images, [capturedWebsite.pages[0].views[0].screenshot!.dataUrl]);
  assert.match(finalCall.persona, /Complete conflict reconciliation before writing/);
  assert.equal(result.result.text, "Review completed.");
});

test("lead-control timeout replaces the lead and preserves research screenshots and critique", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const lead = fakeProvider({ name: "anthropic", modelId: "failed-lead", controlResponses: [] });
  lead.generate = async () => {
    queueMicrotask(() => t.mock.timers.tick(120_000));
    return new Promise<ProviderResponse>(() => {});
  };
  lead.generateStream = async () => { assert.fail("failed control lead should be replaced"); };
  const { research, reviewer } = reviewHelpers();
  const replacement = fakeProvider({ name: "google", modelId: "replacement", controlResponses: [], finalText: "Recovered." });
  let selections = 0;
  const result = await runAdaptiveCollaboration({ requestId: "control-timeout", leadProvider: lead, leadModelId: "failed-lead",
    providers: [lead, research, reviewer, replacement], params: marketingParams,
    collectWebsiteEvidence: async () => capturedWebsite,
    selectHelper: async ({ request }) => request.capability === "research" ? { provider: research, modelId: "research" } : { provider: reviewer, modelId: "reviewer" },
    selectReplacementLead: async (context) => {
      selections++;
      assert.equal(context.contributions.length, 2);
      assert.equal(context.hasImages, true);
      return { provider: replacement, modelId: "replacement" };
    },
  });
  assert.equal(selections, 1);
  assert.match(result.trace.find((event) => event.type === "lead_failed")?.detail ?? "", /timed out after 120000ms/);
  assert.equal(research.calls.length, 1);
  assert.equal(reviewer.calls.length, 1);
  assert.equal(result.result.provider, "google");
  assert.match(replacement.calls[0].user, /Verified website evidence/);
  assert.match(replacement.calls[0].user, /Independent critique/);
  assert.deepEqual(replacement.calls[0].images, [capturedWebsite.pages[0].views[0].screenshot!.dataUrl]);
});

test("final-synthesis timeout leaves time for replacement instead of consuming all remaining budget", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const lead = fakeProvider({ name: "anthropic", modelId: "lead", controlResponses: [JSON.stringify({ action: "ready", synthesisBrief: "Use evidence", conflicts: [] })] });
  lead.generateStream = async () => {
    queueMicrotask(() => t.mock.timers.tick(180_000));
    return new Promise<ProviderResponse>(() => {});
  };
  const replacement = fakeProvider({ name: "google", modelId: "replacement", controlResponses: [], finalText: "Recovered after synthesis timeout." });
  const result = await runAdaptiveCollaboration({ requestId: "synthesis-timeout", leadProvider: lead, leadModelId: "lead",
    providers: [lead, replacement], params: baseParams, selectHelper: async () => null,
    selectReplacementLead: async () => ({ provider: replacement, modelId: "replacement" }),
  });
  assert.match(result.trace.find((event) => event.type === "lead_failed")?.detail ?? "", /timed out after 180000ms/);
  assert.equal(result.result.provider, "google");
  assert.equal(result.metadata.durationMs, 180_000);
});

test("outer reroute resumes synthesis from checkpoint without repeating any completed work", async () => {
  const lead = fakeProvider({ name: "anthropic", modelId: "lead", controlResponses: [JSON.stringify({ action: "ready", synthesisBrief: "Use all evidence" })] });
  lead.generateStream = async () => { throw new Error("Provider unavailable"); };
  const { research, reviewer } = reviewHelpers();
  let saved: CollaborationResumeState | undefined;
  let captures = 0;
  const options = { requestId: "outer-reroute", leadProvider: lead, leadModelId: "lead", providers: [lead, research, reviewer], params: marketingParams,
    onCheckpoint: (state: CollaborationResumeState) => { saved = state; },
    collectWebsiteEvidence: async () => { captures++; return capturedWebsite; },
    selectHelper: async ({ request }: { request: { capability: string } }) => request.capability === "research" ? { provider: research, modelId: "research" } : { provider: reviewer, modelId: "reviewer" },
  };
  await assert.rejects(runAdaptiveCollaboration(options), /Provider unavailable/);
  assert.equal(saved?.contributions.length, 2);
  const replacement = fakeProvider({ name: "google", modelId: "replacement", controlResponses: [], finalText: "Resumed answer." });
  const result = await runAdaptiveCollaboration({ ...options, leadProvider: replacement, leadModelId: "replacement", resumeState: saved,
    selectHelper: async () => { assert.fail("resumed turn must not select helpers"); },
  });
  assert.equal(captures, 1);
  assert.equal(research.calls.length, 1);
  assert.equal(reviewer.calls.length, 1);
  assert.equal(replacement.calls.length, 1);
  assert.equal(result.metadata.delegationCount, 2);
  assert.equal(result.trace.some((event) => event.type === "collaboration_resumed"), true);
  assert.match(replacement.calls[0].user, /Independent critique/);
  assert.match(replacement.calls[0].user, /id=\\"hero\\"/);
  assert.deepEqual(replacement.calls[0].images, [capturedWebsite.pages[0].views[0].screenshot!.dataUrl]);
});

test("conflict reconciliation preserves strategic objectives and classifies evidence disputes", async () => {
  const conflicts = [{ kind: "strategic-objective", disagreement: "CFO-only headline vs three-operator firm", resolution: "Keep broad positioning; use finance proof without redefining the firm", unresolved: false },
    { kind: "evidence-quality", disagreement: "Extracted order implies email-only hero", resolution: "DOM hero and screenshot show booking CTA", unresolved: false }];
  const lead = fakeProvider({ name: "anthropic", modelId: "lead", controlResponses: [JSON.stringify({ action: "ready", synthesisBrief: "Preserve firm strategy", conflicts })], finalText: "Keep the broad firm positioning." });
  const { research, reviewer } = reviewHelpers();
  const result = await runAdaptiveCollaboration({ requestId: "strategy-conflict", leadProvider: lead, leadModelId: "lead",
    providers: [lead, research, reviewer], params: marketingParams, collectWebsiteEvidence: async () => capturedWebsite,
    selectHelper: async ({ request }) => request.capability === "research" ? { provider: research, modelId: "research" } : { provider: reviewer, modelId: "reviewer" },
  });
  assert.match(lead.calls[0].persona, /established user\/project objectives take priority/);
  assert.match(reviewer.calls[0].persona, /Changes to target customer, core positioning/);
  assert.match(lead.calls.at(-1)!.persona, /Extracted text order alone does not prove rendered placement/);
  assert.equal(lead.calls.at(-1)!.summary, marketingParams.summary);
  assert.match(lead.calls.at(-1)!.user, /"kind":"strategic-objective"/);
  assert.match(lead.calls.at(-1)!.user, /"kind":"evidence-quality"/);
  assert.match(result.trace.find((event) => event.type === "reconciliation_completed")?.detail ?? "", /Classified conflicts=2; unresolved=0/);
  const parsed = parseLeadControlDecision(JSON.stringify({ action: "ready", synthesisBrief: "Need clarification", conflicts: [{ ...conflicts[0], unresolved: true }] }));
  assert.equal(parsed?.action === "ready" && parsed.conflicts?.[0].unresolved, true);
});

test("resume checkpoints cannot leak website evidence into a different user turn", async () => {
  const lead = fakeProvider({ name: "anthropic", modelId: "lead", controlResponses: [JSON.stringify({ action: "ready", synthesisBrief: "Answer this turn", conflicts: [] })], finalText: "Fresh answer." });
  const foreign: CollaborationResumeState = { requestId: "other-turn", contributions: [], usedParticipants: [], completedHelpers: [],
    delegationCount: 4, maxDepthReached: 2, totalContributionChars: 0, synthesisBrief: "Foreign strategy", notes: ["Foreign notes"], website: capturedWebsite };
  const result = await runAdaptiveCollaboration({ requestId: "fresh-turn", resumeState: foreign,
    leadProvider: lead, leadModelId: "lead", providers: [lead], params: baseParams, selectHelper: async () => null });
  assert.equal(result.metadata.delegationCount, 0);
  assert.equal(result.trace.some((event) => event.type === "collaboration_resumed"), false);
  assert.equal(lead.calls.at(-1)?.images, undefined);
  assert.doesNotMatch(lead.calls.at(-1)!.user, /Foreign strategy|Foreign notes|Book a call/);
});

test("slow website review retains full critique and final backup windows", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const { research, reviewer } = reviewHelpers();
  const getResearch = research.generate.bind(research);
  research.generate = async (params) => { t.mock.timers.tick(163_000); return getResearch(params); };
  const getReview = reviewer.generate.bind(reviewer);
  reviewer.generate = async (params) => { t.mock.timers.tick(60_000); return getReview(params); };
  const lead = fakeProvider({ name: "anthropic", modelId: "lead", controlResponses: [JSON.stringify({ action: "ready", synthesisBrief: "Use evidence", conflicts: [] })] });
  lead.generateStream = async () => {
    queueMicrotask(() => t.mock.timers.tick(180_000));
    return new Promise<ProviderResponse>(() => {});
  };
  const backup = fakeProvider({ name: "google", modelId: "backup", controlResponses: [], finalText: "Recovered with evidence." });
  const finish = backup.generateStream!.bind(backup);
  backup.generateStream = async (params, handlers) => { t.mock.timers.tick(155_000); return finish(params, handlers); };
  const result = await runAdaptiveCollaboration({ requestId: "slow-full-backup", leadProvider: lead, leadModelId: "lead",
    providers: [lead, research, reviewer, backup], params: marketingParams,
    collectWebsiteEvidence: async () => capturedWebsite,
    selectHelper: async ({ request }) => request.capability === "research" ? { provider: research, modelId: "research" } : { provider: reviewer, modelId: "reviewer" },
    selectReplacementLead: async () => ({ provider: backup, modelId: "backup" }),
  });
  assert.equal(result.result.text, "Recovered with evidence.");
  assert.equal(reviewer.calls.length, 1);
  assert.match(backup.calls[0].user, /Independent critique/);
  assert.deepEqual(backup.calls[0].images, [capturedWebsite.pages[0].views[0].screenshot!.dataUrl]);
  assert.equal(result.trace.filter(event => event.type === "lead_failed").length, 1);
  assert.equal(result.metadata.durationMs, 558_000);
});

test("exhausted request deadline never selects a doomed replacement or resets on resume", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const lead = fakeProvider({ name: "anthropic", modelId: "lead", controlResponses: [], finalText: "unused" });
  lead.generateStream = async () => {
    queueMicrotask(() => t.mock.timers.tick(180_000));
    return new Promise<ProviderResponse>(() => {});
  };
  let saved: CollaborationResumeState | undefined;
  const options = { requestId: "fixed-deadline", leadProvider: lead, leadModelId: "lead", providers: [lead], params: baseParams,
    executionDeadlineMs: 190_000,
    selectHelper: async () => null,
    selectReplacementLead: async () => { assert.fail("No time to run a replacement"); },
    onCheckpoint: (state: CollaborationResumeState) => { saved = state; },
  };
  await assert.rejects(runAdaptiveCollaboration(options), /timed out/);
  await assert.rejects(runAdaptiveCollaboration({ ...options, resumeState: saved }), /insufficient execution time/);
});

test("research timeout gets a different helper with a full research window", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const lead = fakeProvider({ name: "anthropic", modelId: "lead", controlResponses: [], finalText: "Used backup research." });
  const failed = fakeProvider({ name: "grok", modelId: "failed-research", controlResponses: [] });
  failed.generate = async () => {
    queueMicrotask(() => t.mock.timers.tick(240_000));
    return new Promise<ProviderResponse>(() => {});
  };
  const backup = fakeProvider({ name: "openai", modelId: "backup-research", controlResponses: ["Recovered live evidence."] });
  const getResearch = backup.generate.bind(backup);
  backup.generate = async (params) => { t.mock.timers.tick(163_000); return getResearch(params); };
  let selections = 0;
  const result = await runAdaptiveCollaboration({ requestId: "research-backup", leadProvider: lead, leadModelId: "lead",
    providers: [lead, failed, backup], params: { ...marketingParams, requestIntent: "general-text" },
    collectWebsiteEvidence: async () => capturedWebsite,
    selectHelper: async () => ++selections === 1 ? { provider: failed, modelId: "failed-research" } : { provider: backup, modelId: "backup-research" },
  });
  assert.equal(selections, 2);
  assert.equal(backup.calls.length, 1);
  assert.match(lead.calls.at(-1)!.user, /Recovered live evidence/);
  assert.equal(result.trace.filter(event => event.type === "helper_retrying").length, 1);
});

test("research result that arrives during the late-result grace window is preserved instead of discarded", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const lead = fakeProvider({ name: "anthropic", modelId: "lead", controlResponses: [], finalText: "Used late research." });
  const late = fakeProvider({ name: "grok", modelId: "late-research", controlResponses: [] });
  late.generate = async (params) => {
    late.calls.push(params);
    const result = new Promise<ProviderResponse>((resolve) => {
      setTimeout(() => resolve({
        text: "Late but valid competitor evidence.",
        provider: "grok",
        model: "late-research",
      }), 218_000);
    });
    queueMicrotask(() => t.mock.timers.tick(218_000));
    return result;
  };

  let selections = 0;
  const result = await runAdaptiveCollaboration({
    requestId: "research-late-result",
    leadProvider: lead,
    leadModelId: "lead",
    providers: [lead, late],
    params: { ...marketingParams, requestIntent: "general-text" },
    collectWebsiteEvidence: async () => capturedWebsite,
    selectHelper: async () => {
      selections += 1;
      if (selections > 1) assert.fail("late successful research must not trigger a backup");
      return { provider: late, modelId: "late-research" };
    },
  });

  assert.equal(selections, 1);
  assert.equal(result.metadata.contributions.length, 1);
  assert.match(lead.calls.at(-1)!.user, /Late but valid competitor evidence/);
  assert.equal(result.trace.some((event) => event.type === "helper_failed"), false);
});

test("package-planning follow-up reuses saved context without automatic website retrieval", async () => {
  const lead = fakeProvider({ name: "anthropic", modelId: "lead", controlResponses: [JSON.stringify({ action: "ready", synthesisBrief: "Design bookkeeping packages", conflicts: [] })], finalText: "Three service packages." });
  const result = await runAdaptiveCollaboration({ requestId: "package-followup", leadProvider: lead, leadModelId: "lead", providers: [lead],
    params: { ...marketingParams, user: "Focus on bookkeeping and month end close. Create service packages for ecommerce clients.", secondaryIntents: ["rewrite"],
      persona: "STORED_WEBSITE_INSPECTION: earlier evidence", history: [{ role: "user", content: "Review https://example.com/" }] },
    selectHelper: async () => { assert.fail("A historical URL must not cause another inspection"); },
    collectWebsiteEvidence: async () => { assert.fail("No new capture needed"); },
  });
  assert.equal(result.result.text, "Three service packages.");
  assert.match(lead.calls[0].persona, /STORED_WEBSITE_INSPECTION/);
});
