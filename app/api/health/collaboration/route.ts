import { NextResponse } from "next/server";
import { runAdaptiveCollaboration } from "@/lib/collaboration/orchestrator";
import { runWithRefusalFallback } from "@/lib/router/refusal-detection";
import {
  classifyGenerationFailure,
  filterHealthyProviders,
} from "@/lib/router/provider-error";
import type { CollaborationHelperSelection } from "@/lib/collaboration/types";
import type {
  ChatGenerateParams,
  LlmProvider,
  ProviderResponse,
  ProviderStreamHandlers,
} from "@/lib/providers/types";

export const dynamic = "force-dynamic";

type FakeProvider = LlmProvider & {
  calls: ChatGenerateParams[];
};

function makeProvider(input: {
  name: LlmProvider["name"];
  modelId: string;
  controlResponses: string[];
  finalText?: string;
}): FakeProvider {
  const calls: ChatGenerateParams[] = [];
  let controlIndex = 0;

  return {
    name: input.name,
    calls,
    async listModels() {
      return [input.modelId];
    },
    async generate(params) {
      calls.push(params);
      const text = input.controlResponses[controlIndex] ?? "";
      controlIndex += 1;
      return {
        text,
        provider: input.name,
        model: params.modelId ?? input.modelId,
      } satisfies ProviderResponse;
    },
    async generateStream(
      params: ChatGenerateParams,
      handlers: ProviderStreamHandlers,
    ) {
      calls.push(params);
      const text = input.finalText ?? "health-check-final";
      await handlers.onTextDelta?.(text);
      return {
        text,
        provider: input.name,
        model: params.modelId ?? input.modelId,
      } satisfies ProviderResponse;
    },
  };
}

const baseParams: ChatGenerateParams = {
  name: "Katie",
  persona: "Health-check persona.",
  summary: "",
  history: [],
  user: "Run the deterministic collaboration health check.",
  requestIntent: "architecture-review",
  modelId: "health-lead",
};

async function runBasicDelegationCheck(): Promise<boolean> {
  const lead = makeProvider({
    name: "openai",
    modelId: "health-lead",
    controlResponses: [
      JSON.stringify({
        action: "delegate",
        request: {
          task: "Verify the health-check architecture.",
          capability: "verification",
        },
      }),
      JSON.stringify({
        action: "ready",
        synthesisBrief: "Use the helper verification.",
      }),
    ],
    finalText: "basic-final",
  });

  const helper = makeProvider({
    name: "anthropic",
    modelId: "health-helper",
    controlResponses: [
      JSON.stringify({
        action: "answer",
        answer: "Verified.",
        confidence: "high",
      }),
    ],
  });

  const result = await runAdaptiveCollaboration({
    requestId: "health-basic",
    leadProvider: lead,
    leadModelId: "health-lead",
    providers: [lead, helper],
    params: baseParams,
    async selectHelper(): Promise<CollaborationHelperSelection> {
      return { provider: helper, modelId: "health-helper" };
    },
  });

  return (
    result.result.text === "basic-final" &&
    result.metadata.delegationCount === 1 &&
    result.metadata.contributors.some(
      (value) =>
        value.provider === "anthropic" && value.modelId === "health-helper",
    )
  );
}

async function runNestedDelegationCheck(): Promise<boolean> {
  const lead = makeProvider({
    name: "openai",
    modelId: "nested-lead",
    controlResponses: [
      JSON.stringify({
        action: "delegate",
        request: {
          task: "Review the health-check architecture.",
          capability: "architecture",
        },
      }),
      JSON.stringify({
        action: "ready",
        synthesisBrief: "Use the nested review.",
      }),
    ],
    finalText: "nested-final",
  });

  const helperA = makeProvider({
    name: "anthropic",
    modelId: "nested-helper-a",
    controlResponses: [
      JSON.stringify({
        action: "delegate",
        request: {
          task: "Verify the nested assumption.",
          capability: "verification",
        },
      }),
      JSON.stringify({
        action: "answer",
        answer: "Nested review complete.",
        confidence: "high",
      }),
    ],
  });

  const helperB = makeProvider({
    name: "google",
    modelId: "nested-helper-b",
    controlResponses: [
      JSON.stringify({
        action: "answer",
        answer: "Nested assumption verified.",
        confidence: "high",
      }),
    ],
  });

  const result = await runAdaptiveCollaboration({
    requestId: "health-nested",
    leadProvider: lead,
    leadModelId: "nested-lead",
    providers: [lead, helperA, helperB],
    params: {
      ...baseParams,
      modelId: "nested-lead",
    },
    maxDepth: 2,
    maxDelegations: 4,
    async selectHelper(context) {
      return context.depth === 1
        ? { provider: helperA, modelId: "nested-helper-a" }
        : { provider: helperB, modelId: "nested-helper-b" };
    },
  });

  return (
    result.result.text === "nested-final" &&
    result.metadata.delegationCount === 2 &&
    result.metadata.maxDepthReached === 2 &&
    result.metadata.contributors.length === 2
  );
}

async function runHelperRetryCheck(): Promise<boolean> {
  const lead = makeProvider({
    name: "anthropic",
    modelId: "retry-lead",
    controlResponses: [
      JSON.stringify({
        action: "delegate",
        request: {
          task: "Critique the health-check explanation.",
          capability: "critique",
        },
      }),
      JSON.stringify({
        action: "ready",
        synthesisBrief: "Use the replacement helper critique.",
      }),
    ],
    finalText: "retry-final",
  });

  const failedHelper = makeProvider({
    name: "google",
    modelId: "retry-helper-failed",
    controlResponses: [""],
  });

  const replacementHelper = makeProvider({
    name: "openai",
    modelId: "retry-helper-replacement",
    controlResponses: [
      JSON.stringify({
        action: "answer",
        answer: "Replacement critique complete.",
        confidence: "high",
      }),
    ],
  });

  let selectionCount = 0;
  const result = await runAdaptiveCollaboration({
    requestId: "health-helper-retry",
    leadProvider: lead,
    leadModelId: "retry-lead",
    providers: [lead, failedHelper, replacementHelper],
    params: {
      ...baseParams,
      modelId: "retry-lead",
    },
    maxDelegations: 3,
    async selectHelper() {
      selectionCount += 1;
      return selectionCount === 1
        ? { provider: failedHelper, modelId: "retry-helper-failed" }
        : { provider: replacementHelper, modelId: "retry-helper-replacement" };
    },
  });

  return (
    selectionCount === 2 &&
    result.result.text === "retry-final" &&
    result.metadata.delegationCount === 1 &&
    result.metadata.contributors.some(
      (value) => value.modelId === "retry-helper-replacement",
    ) &&
    result.trace.some((event) => event.type === "helper_retrying")
  );
}

async function runLeadFailoverCheck(): Promise<boolean> {
  const leadCalls: ChatGenerateParams[] = [];
  let leadControlIndex = 0;
  const failingLead: FakeProvider = {
    name: "openai",
    calls: leadCalls,
    async listModels() {
      return ["health-failing-lead"];
    },
    async generate(params) {
      leadCalls.push(params);
      const responses = [
        JSON.stringify({
          action: "delegate",
          request: {
            task: "Review the architecture.",
            capability: "architecture",
          },
        }),
        JSON.stringify({
          action: "ready",
          synthesisBrief: "Use the completed helper review.",
        }),
      ];
      const text = responses[leadControlIndex] ?? "";
      leadControlIndex += 1;
      return {
        text,
        provider: "openai",
        model: params.modelId ?? "health-failing-lead",
      };
    },
    async generateStream() {
      throw new Error("429 You have no credits remaining.");
    },
  };

  const helper = makeProvider({
    name: "anthropic",
    modelId: "health-preserved-helper",
    controlResponses: [
      JSON.stringify({
        action: "answer",
        answer: "Preserved health-check architecture evidence.",
        confidence: "high",
      }),
    ],
  });

  const replacement = makeProvider({
    name: "google",
    modelId: "health-replacement-lead",
    controlResponses: [],
    finalText: "health-replacement-final",
  });

  let helperSelections = 0;
  let replacementSelections = 0;
  const result = await runAdaptiveCollaboration({
    requestId: "health-lead-failover",
    leadProvider: failingLead,
    leadModelId: "health-failing-lead",
    providers: [failingLead, helper, replacement],
    params: {
      ...baseParams,
      modelId: "health-failing-lead",
    },
    async selectHelper() {
      helperSelections += 1;
      return { provider: helper, modelId: "health-preserved-helper" };
    },
    async selectReplacementLead(context) {
      replacementSelections += 1;
      if (
        context.contributions.length !== 1 ||
        !context.contributions[0]?.answer.includes("Preserved health-check")
      ) {
        return null;
      }
      return {
        provider: replacement,
        modelId: "health-replacement-lead",
      };
    },
  });

  return (
    helperSelections === 1 &&
    replacementSelections === 1 &&
    result.result.provider === "google" &&
    result.result.model === "health-replacement-lead" &&
    result.result.text === "health-replacement-final" &&
    result.trace.some((event) => event.type === "lead_failed") &&
    result.trace.some((event) => event.type === "lead_replaced")
  );
}

async function runProviderErrorRerouteCheck(): Promise<boolean> {
  const openai = makeProvider({
    name: "openai",
    modelId: "health-openai-broken",
    controlResponses: [],
  });
  const google = makeProvider({
    name: "google",
    modelId: "health-google-replacement",
    controlResponses: [],
  });

  const providers: LlmProvider[] = [openai, google];
  const failedProviders = new Set<LlmProvider["name"]>();
  const executed: string[] = [];

  const { result, attempt } = await runWithRefusalFallback<{
    provider: LlmProvider;
    modelId: string;
  }>({
    attempts: [
      { provider: openai, modelId: "health-openai-broken" },
      { provider: openai, modelId: "health-openai-static-fallback" },
    ],
    shouldRetryRefusal: true,
    async runAttempt(candidate) {
      executed.push(`${candidate.provider.name}:${candidate.modelId}`);
      if (candidate.provider.name === "openai") {
        throw new Error("429 You have no credits remaining.");
      }
      return {
        provider: "google",
        model: candidate.modelId,
        text: "provider-error-reroute-final",
      };
    },
    detectRefusal() {
      return false;
    },
    async rerouteOnError({ attempt: failedAttempt, error }) {
      if (classifyGenerationFailure(error) === "provider") {
        failedProviders.add(failedAttempt.provider.name);
      }
      const healthy = filterHealthyProviders(
        providers,
        failedProviders,
        failedAttempt.provider.name,
      );
      const replacement = healthy[0];
      return replacement
        ? { provider: replacement, modelId: "health-google-replacement" }
        : null;
    },
  });

  return (
    classifyGenerationFailure(
      new Error("429 You have no credits remaining."),
    ) === "provider" &&
    failedProviders.has("openai") &&
    executed.join(",") ===
      "openai:health-openai-broken,google:health-google-replacement" &&
    attempt.provider.name === "google" &&
    result.text === "provider-error-reroute-final"
  );
}

async function runBudgetCheck(): Promise<boolean> {
  const lead = makeProvider({
    name: "grok",
    modelId: "budget-lead",
    controlResponses: [
      JSON.stringify({
        action: "delegate",
        request: { task: "First check.", capability: "analysis" },
      }),
      JSON.stringify({
        action: "delegate",
        request: { task: "Second check.", capability: "critique" },
      }),
    ],
    finalText: "budget-final",
  });

  const helper = makeProvider({
    name: "google",
    modelId: "budget-helper",
    controlResponses: [
      JSON.stringify({
        action: "answer",
        answer: "First check complete.",
      }),
    ],
  });

  const result = await runAdaptiveCollaboration({
    requestId: "health-budget",
    leadProvider: lead,
    leadModelId: "budget-lead",
    providers: [lead, helper],
    params: {
      ...baseParams,
      modelId: "budget-lead",
    },
    maxDelegations: 1,
    async selectHelper() {
      return { provider: helper, modelId: "budget-helper" };
    },
  });

  return (
    result.result.text === "budget-final" &&
    result.metadata.delegationCount === 1 &&
    result.trace.some((event) => event.type === "limit_reached")
  );
}

export async function GET() {
  const startedAt = Date.now();

  try {
    const [
      basicDelegation,
      nestedDelegation,
      helperRetry,
      leadFailover,
      providerErrorReroute,
      boundedDelegation,
    ] = await Promise.all([
      runBasicDelegationCheck(),
      runNestedDelegationCheck(),
      runHelperRetryCheck(),
      runLeadFailoverCheck(),
      runProviderErrorRerouteCheck(),
      runBudgetCheck(),
    ]);

    const ok =
      basicDelegation &&
      nestedDelegation &&
      helperRetry &&
      leadFailover &&
      providerErrorReroute &&
      boundedDelegation;

    return NextResponse.json(
      {
        ok,
        checks: {
          basicDelegation,
          nestedDelegation,
          helperRetry,
          leadFailover,
          providerErrorReroute,
          boundedDelegation,
        },
        durationMs: Date.now() - startedAt,
      },
      {
        status: ok ? 200 : 500,
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
        },
      },
    );
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      },
      {
        status: 500,
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
        },
      },
    );
  }
}
