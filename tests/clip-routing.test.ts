import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { selectVideoReplyTarget, generateContextualVideoReply, buildContextualVideoReplyPrompt } from "../lib/chat/video-response";
import type { LlmProvider } from "../lib/providers/types";

const claude: LlmProvider = {
  name: "anthropic",
  listModels: async () => ["claude-sonnet-5", "claude-fable-5-1"],
  generate: async params => ({ model: params.modelId || "", provider: "anthropic", text: "That fits our earlier discussion." }),
};
const google: LlmProvider = {
  name: "google", listModels: async () => ["gemini-2.5-flash"],
  generate: async () => ({ model: "gemini-2.5-flash", provider: "google", text: "A trail climbs up a steep slope." }),
};

test("video inspection and conversation model selections stay independent", async () => {
  assert.deepEqual(await selectVideoReplyTarget([google, claude],
    { provider: "anthropic", model: "claude-fable-5-1" }),
  { provider: "anthropic", model: "claude-fable-5-1" });
  assert.deepEqual(await selectVideoReplyTarget([google, claude]),
    { provider: "anthropic", model: "claude-fable-5-1" });
});

test("unavailable manual selection produces an explicit error", async () => {
  await assert.rejects(selectVideoReplyTarget([google, claude],
    { provider: "anthropic", model: "claude-unknown" }), /unavailable/);
});

test("conversation provider receives text evidence and prior turns, never raw video", async () => {
  let sent: unknown = null;
  const provider = {
    ...claude, generate: async (params: Parameters<typeof claude.generate>[0]) => {
      sent = params;
      return { model: "claude-fable-5-1", provider: "anthropic" as const, text: "I can see the similarity." };
    },
  };
  const reply = await generateContextualVideoReply({
    provider, model: "claude-fable-5-1", persona: "Katie",
    summary: "We are discussing a hiking trail.",
    history: [{ role: "user", content: "Is that trail steep?" }],
    userQuestion: "Like this?",
    observations: "A person walks up a steep trail.",
  });
  assert.equal(reply.model, "claude-fable-5-1");
  assert.deepEqual((sent as { attachments: unknown[] }).attachments, []);
  assert.deepEqual((sent as { images: unknown[] }).images, []);
  assert.match((sent as { user: string }).user, /steep trail/);
  assert.match(buildContextualVideoReplyPrompt("Like this?", "A trail"),
    /conversation history/);
});

test("chat routing and independent background worker use contextual synthesis", () => {
  const route = readFileSync("app/api/chat/route.ts", "utf8");
  const publisher = readFileSync("lib/runpod/video-orchestration.ts", "utf8");
  const synthesis = readFileSync("lib/runpod/video-conversation.ts", "utf8");
  assert.match(route, /videoRoutingPolicy.mode === "handoff-google"/);
  assert.match(route, /video_reply_provider: videoReplyTarget.provider/);
  assert.match(route, /generateContextualVideoReply\(/);
  assert.match(publisher, /finalizeContextualVideoReply\(/);
  assert.match(synthesis, /\.lt\("created_at", placeholder.created_at\)/);
});

test('a pending video with an already-completed chat placeholder remains synthesizable', () => {
  const code = readFileSync('lib/runpod/video-conversation.ts', 'utf8');
  assert.match(code, /state.status !== "processing" && state.status !== "completed"/);
});
