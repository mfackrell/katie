import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeProvider } from "../lib/providers/claude-provider";

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
