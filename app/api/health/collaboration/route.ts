import { NextResponse } from "next/server";
import { runAdaptiveCollaboration } from "@/lib/collaboration/orchestrator";
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
    const [basicDelegation, nestedDelegation, boundedDelegation] =
      await Promise.all([
        runBasicDelegationCheck(),
        runNestedDelegationCheck(),
        runBudgetCheck(),
      ]);

    const ok = basicDelegation && nestedDelegation && boundedDelegation;

    return NextResponse.json(
      {
        ok,
        checks: {
          basicDelegation,
          nestedDelegation,
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
