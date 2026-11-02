import nodeTest from "node:test";
import { runWithOrchestratorAccounting } from "../lib/standalone-accounting/context";
// Adapter compatibility tests explicitly model the existing trusted orchestration scope.
const test = (name: string, fn: () => Promise<void>) => nodeTest(name, () => runWithOrchestratorAccounting(fn));
import assert from "node:assert/strict";
import { ClaudeProvider } from "../lib/providers/claude-provider";
import { decideResponsePolicy } from "../lib/chat/response-policy";
import { getDeliverableStandardInstruction } from "../lib/chat/deliverable-standard";
import { getAdaptiveResponseCompositionInstruction } from "../lib/chat/adaptive-response-composition";
import { readFileSync } from "node:fs";

const baseParams = {
  name: "Katie",
  persona: "Be helpful.",
  summary: "No memory.",
  user: "Write a comprehensive answer.",
  history: [],
  modelId: "claude-sonnet-5-5",
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(events: unknown[]): Response {
  const payload = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(payload, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

test("ClaudeProvider continues non-stream responses after max_tokens and preserves the boundary", async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies: Array<Record<string, unknown>> = [];
  let call = 0;

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    call += 1;

    if (call === 1) {
      return jsonResponse({
        content: [{ type: "text", text: "Part 1 " }],
        stop_reason: "max_tokens",
        usage: { input_tokens: 100, output_tokens: 16384 },
      });
    }

    return jsonResponse({
      content: [{ type: "text", text: "Part 2" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 200, output_tokens: 50 },
    });
  }) as typeof fetch;

  try {
    const provider = new ClaudeProvider("test-key");
    const result = await provider.generate(baseParams);

    assert.equal(result.text, "Part 1 Part 2");
    assert.equal(result.finishReason, "end_turn");
    assert.equal(result.truncated, false);
    assert.equal(result.continuationCount, 1);
    assert.equal(result.usage?.inputTokens, 300);
    assert.equal(result.usage?.outputTokens, 16434);
    assert.equal(requestBodies.length, 2);
    assert.equal(requestBodies[0].max_tokens, 16384);
    assert.equal(requestBodies[0].stream, undefined);

    const secondMessages = requestBodies[1].messages as Array<{ role: string; content: string }>;
    assert.equal(secondMessages.at(-2)?.role, "assistant");
    assert.equal(secondMessages.at(-2)?.content, "Part 1");
    assert.equal(secondMessages.at(-1)?.role, "user");
    assert.match(secondMessages.at(-1)?.content ?? "", /Continue exactly where/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ClaudeProvider streams continuations and returns one stitched response", async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies: Array<Record<string, unknown>> = [];
  let call = 0;

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    call += 1;

    if (call === 1) {
      return sseResponse([
        {
          type: "message_start",
          message: { usage: { input_tokens: 100, output_tokens: 0 } },
        },
        {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Part 1 " },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "max_tokens" },
          usage: { output_tokens: 16384 },
        },
        { type: "message_stop" },
      ]);
    }

    return sseResponse([
      {
        type: "message_start",
        message: { usage: { input_tokens: 200, output_tokens: 0 } },
      },
      {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Part 2" },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 50 },
      },
      { type: "message_stop" },
    ]);
  }) as typeof fetch;

  try {
    const provider = new ClaudeProvider("test-key");
    let streamed = "";
    const result = await provider.generateStream(baseParams, {
      onTextDelta(delta) {
        streamed += delta;
      },
    });

    assert.equal(streamed, "Part 1 Part 2");
    assert.equal(result.text, "Part 1 Part 2");
    assert.equal(result.finishReason, "end_turn");
    assert.equal(result.truncated, false);
    assert.equal(result.continuationCount, 1);
    assert.equal(requestBodies.length, 2);
    assert.equal(requestBodies[0].max_tokens, 16384);
    assert.equal(requestBodies[0].stream, true);

    const secondMessages = requestBodies[1].messages as Array<{ role: string; content: string }>;
    assert.equal(secondMessages.at(-2)?.role, "assistant");
    assert.equal(secondMessages.at(-2)?.content, "Part 1");
    assert.equal(secondMessages.at(-1)?.role, "user");
    assert.match(secondMessages.at(-1)?.content ?? "", /Continue exactly where/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("Claude continuation payload never ends with assistant prefill or trailing assistant whitespace", async () => {
  const originalFetch = globalThis.fetch;
  let call = 0;

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    call += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages?: Array<{ role: string; content: string }>;
    };

    if (call === 2) {
      const messages = body.messages ?? [];
      assert.equal(messages.at(-1)?.role, "user");
      assert.equal(messages.at(-2)?.role, "assistant");
      assert.equal(messages.at(-2)?.content, "Part 1");
      assert.equal(/\s$/.test(messages.at(-2)?.content ?? ""), false);
    }

    if (call === 1) {
      return jsonResponse({
        content: [{ type: "text", text: "Part 1   " }],
        stop_reason: "max_tokens",
        usage: { input_tokens: 10, output_tokens: 16384 },
      });
    }

    return jsonResponse({
      content: [{ type: "text", text: "Part 2" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 20, output_tokens: 20 },
    });
  }) as typeof fetch;

  try {
    const provider = new ClaudeProvider("test-key");
    const result = await provider.generate(baseParams);
    assert.equal(call, 2);
    assert.equal(result.finishReason, "end_turn");
    assert.equal(result.truncated, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ClaudeProvider marks output truncated after exhausting continuation passes", async () => {
  const originalFetch = globalThis.fetch;
  let call = 0;

  globalThis.fetch = (async () => {
    call += 1;
    return jsonResponse({
      content: [{ type: "text", text: `chunk-${call} ` }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 10, output_tokens: 16384 },
    });
  }) as typeof fetch;

  try {
    const provider = new ClaudeProvider("test-key");
    const result = await provider.generate(baseParams);

    assert.equal(call, 4);
    assert.equal(result.truncated, true);
    assert.equal(result.finishReason, "max_tokens");
    assert.equal(result.continuationCount, 3);
    assert.match(
      result.text,
      /Response reached the maximum output length and could not be fully completed\./,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Claude sends rendered website images on both normal and streaming requests", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    requests.push(body);
    return body.stream ? sseResponse([
      { type: "content_block_delta", delta: { type: "text_delta", text: "Visual review" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
    ]) : jsonResponse({ content: [{ type: "text", text: "Visual review" }], stop_reason: "end_turn" });
  }) as typeof fetch;
  try {
    const provider = new ClaudeProvider("test-key");
    const images = ["data:image/jpeg;base64,c2NyZWVuc2hvdA==", "https://example.com/screenshot.png"];
    await provider.generate({ ...baseParams, images });
    await provider.generateStream({ ...baseParams, images }, {});
    for (const request of requests) {
      const messages = request.messages as Array<{ content: Array<Record<string, unknown>> }>;
      const content = messages.at(-1)!.content;
      assert.deepEqual(content[0], { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "c2NyZWVuc2hvdA==" } });
      assert.deepEqual(content[1], { type: "image", source: { type: "url", url: images[1] } });
      assert.deepEqual(content[2], { type: "text", text: baseParams.user });
    }
  } finally { globalThis.fetch = originalFetch; }
});

for (const streaming of [false, true]) {
  test(`Claude cache preserves prompt and timestamps, and counts reads/writes (${streaming ? 'stream' : 'JSON'})`, async () => {
    const originalFetch = globalThis.fetch;
    const requests: any[] = [];
    const usage = { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 5 };
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return requests.at(-1).stream ? sseResponse([
        { type: 'message_start', message: { usage } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      ]) : jsonResponse({ content: [{ type: 'text', text: 'Done' }], stop_reason: 'end_turn', usage });
    }) as typeof fetch;
    try {
      const provider = new ClaudeProvider('test');
      const params = { ...baseParams, persona: 'Stable instructions\n\nCURRENT_REQUEST_TIMESTAMP_UTC: 2026-10-28T12:00:00Z', cacheablePersona: 'Stable instructions' };
      const plain = { ...params, cacheablePersona: undefined };
      await provider.generate(plain);
      const result = streaming ? await provider.generateStream(params, {}) : await provider.generate(params);
      assert.equal(requests[1].system.map((b: any) => b.text).join(''), requests[0].system);
      assert.deepEqual(requests[1].system[0].cache_control, { type: 'ephemeral', ttl: '5m' });
      assert.ok(!requests[1].system[0].text.includes('CURRENT_REQUEST_TIMESTAMP'));
      assert.ok(requests[1].system[1].text.includes('2026-10-28T12:00:00Z'));
      assert.equal(requests[1].system[1].cache_control, undefined);
      assert.deepEqual(requests[1].messages, requests[0].messages);
      assert.equal(result.usage?.inputTokens, 1210);
      assert.equal(result.usage?.cacheReadInputTokens, 1000);
      assert.equal(result.usage?.cacheCreationInputTokens, 200);
      assert.equal(result.usage?.totalTokens, 1215);
      await provider.generate({ ...params, persona: 'Replaced helper instructions' });
      assert.equal(typeof requests[2].system, 'string');
    } finally { globalThis.fetch = originalFetch; }
  });
}

test("captured first pass matches sent JSON", async () => {
  const priorFetch = globalThis.fetch;
  let sent: any;
  let captured: any;
  globalThis.fetch = (async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return jsonResponse({ content: [{ type: "text", text: "Ok." }], stop_reason: "end_turn" });
  }) as typeof fetch;
  try {
    const provider = new ClaudeProvider("test-key");
    await provider.generate({
      ...baseParams,
      history: [{role:"user",content:"Hello"},{role:"assistant",content:"Hi"}],
      providerPayloadCaptureTrace: {
        actorId:"actor",chatId:"chat",requestId:"req",currentUserMessageId:"u2",
        historySource:"stm",stmVersion:2,stmExchangeCount:1,stmLastAssistantId:"a1",
        persistedLastCompletedAssistantId:"a1",stmMatchesPersistedTail:true,
        historyTurns:[],recentPersistedTurns:[],excludedTurns:[],intermediateSummaryChars:0
      },
      onProviderSystemPrepared: async audit => { captured = audit.requestDiagnostic?.wireRequest; },
    });
    assert.deepEqual(captured, sent);
    assert.equal(sent.messages.at(-1).content, baseParams.user);
  } finally { globalThis.fetch = priorFetch; }
});

test("Claude requests only a final user-facing reply and no intermediate snippets", async () => {
  const priorFetch = globalThis.fetch;
  let system = "";
  globalThis.fetch = (async (_url, init) => {
    const payload = JSON.parse(String(init?.body)) as { system: string | Array<{ text: string }> };
    system = typeof payload.system === "string"
      ? payload.system
      : payload.system.map(block => block.text).join("");
    return jsonResponse({ content: [{ type: "text", text: "A direct answer." }], stop_reason: "end_turn" });
  }) as typeof fetch;
  try {
    const response = await new ClaudeProvider("test-key").generate(baseParams);
    assert.equal(response.text, "A direct answer.");
    assert.match(system, /Respond only with the final answer intended for the user/);
    assert.doesNotMatch(system, /intermediate snippets can be safely shown in a live explainer UI/);
  } finally { globalThis.fetch = priorFetch; }
});

test("actual Anthropic system payload changes only the style for personal conversation", async () => {
  const previousFetch = globalThis.fetch;
  const wirePayloads: Array<{ system: string | Array<{ text: string }>; messages: unknown[] }> = [];
  const auditSystems: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    wirePayloads.push(JSON.parse(String(init?.body)) as { system: string | Array<{ text: string }>; messages: unknown[] });
    return jsonResponse({ content: [{ type: "text", text: "A plain answer." }], stop_reason: "end_turn" });
  }) as typeof fetch;
  try {
    // The same actor + global professional instructions are present in both
    // outgoing requests; only responsePolicy.generationInstruction differs.
    const actorAndGlobal = [
      "Katie actor personality (unchanged).",
      getDeliverableStandardInstruction(),
      getAdaptiveResponseCompositionInstruction(),
    ].join("\n\n");
    const work = decideResponsePolicy({
      message: "What does sponsor reporting mean?",
      intent: "general-text", responsePurpose: "conversation", hasPendingDeliverable: true,
    });
    const personal = decideResponsePolicy({
      message: "I discovered I don't like being alone.",
      intent: "social-emotional", responsePurpose: "conversation",
    });
    for (const choice of [work, personal]) {
      await new ClaudeProvider("offline-test-key").generate({
        ...baseParams,
        cacheablePersona: actorAndGlobal,
        persona: [actorAndGlobal, choice.generationInstruction].filter(Boolean).join("\n\n"),
        user: "Fixture conversation message.",
        onProviderSystemPrepared: audit => { auditSystems.push(audit.systemMessages.join("\n")); },
      });
    }
    assert.equal(wirePayloads.length, 2);
    const systems = wirePayloads.map(payload => typeof payload.system === "string"
      ? payload.system
      : payload.system.map(part => part.text).join(""));
    assert.deepEqual(auditSystems, systems);
    assert.match(systems[0], /KATIE_DELIVERABLE_COMPLETION_STANDARD/);
    assert.match(systems[1], /KATIE_DELIVERABLE_COMPLETION_STANDARD/);
    assert.match(systems[0], /NEXT RESPONSE: a brief conversational answer or clarification/);
    assert.match(systems[1], /Engage naturally rather than simply acknowledging or summarizing/);
    assert.doesNotMatch(systems[1], /normally under 150 words|ask at most one necessary follow-up/);
    assert.equal(systems[1].replace(personal.generationInstruction!, work.generationInstruction!), systems[0],
      "Only the personal-conversation instructions may differ in the actual provider system payload");
    assert.deepEqual(wirePayloads[0].messages, wirePayloads[1].messages);
    const route = readFileSync("app/api/chat/route.ts", "utf8");
    assert.match(route, /\.\.\.\(!forReview \? \[resumptionContext, responsePolicy\.generationInstruction\] : \[\]\)/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
