import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { selectVideoReplyTarget, generateContextualVideoReply, buildContextualVideoReplyPrompt } from "../lib/chat/video-response";
import { buildVideoConversationEvidence } from "../lib/chat/video-evidence";
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

import { savedVideoFollowUpAnchor, loadSavedVideoFollowUp, formatSavedVideoFollowUp } from "../lib/chat/saved-video-observations";
import type { Message } from "../lib/types/chat";

const originalChat = "b7527887-cab2-4cc7-aa97-5dd947c3546c";
const originalActor = "f94eeb41-9bcd-4eb8-9896-bb92e5e3b5c0";
const originalFile = "ca927ecb-340b-4273-ae87-05d09f4d2959";
const originalPath = `chats/${originalChat}/${originalFile}.source`;
const originalTurn: Message[] = [
  {
    id: "4aaf75f1-f372-48fd-8181-44cf049b14a7",
    chatId: originalChat, role: "user",
    content: "Is this video what we discussed?",
    createdAt: "2026-10-11T16:39:34.786Z",
    attachments: [{
      id: originalFile, chatId: originalChat,
      fileName: "sample-recording.mp4", mimeType: "video/mp4",
      conversationUsage: "explicit-reference",
    }],
  },
  {
    id: "ee39b8f8-8136-4bf7-b581-48f02443f77b",
    chatId: originalChat, role: "assistant",
    content: "Yes, it looks similar to what you described.",
    createdAt: "2026-10-11T16:40:12.667Z",
  },
];
const completedEvidence = {
  chat_request_id: "sample-prior-video-request",
  attachment_path: originalPath, source_filename: "sample-recording.mp4",
  analysis_text: "The recording contains a person and a dog moving together in a garden.",
  fallback_text: "The footage shows a person and a dog on a path beside flowers.",
  model: "Qwen/Qwen3-VL-8B-Instruct", fallback_model: "grok-4.7",
  submitted_at: "2026-10-11T16:39:36.513Z", video_index: 0,
};

test("a specific follow-up without the word video identifies the prior same-chat recording", async () => {
  const anchor = savedVideoFollowUpAnchor(
    "Does it include the ending scene?", originalTurn, 0,
  );
  assert.deepEqual(anchor?.attachmentPaths, [originalPath]);
  let readerCalls = 0;
  const result = await loadSavedVideoFollowUp({
    actorId: originalActor, chatId: originalChat,
    message: "Does it include the ending scene?",
    history: originalTurn, freshAttachmentCount: 0,
  }, async ({ actorId, chatId, attachmentPaths }) => {
    readerCalls++;
    assert.equal(actorId, originalActor);
    assert.equal(chatId, originalChat);
    assert.deepEqual(attachmentPaths, [originalPath]);
    return [completedEvidence];
  });
  assert.equal(readerCalls, 1);
  assert.ok(result?.hasObservations);
  assert.equal(result?.sourceCount, 1);
  assert.match(result!.context, /Saved Grok visual observations/);
  assert.match(result!.context, /Saved RunPod visual observations/);
  assert.match(result!.context, /NOT CONFIRMED BY THE SAVED OBSERVATIONS/);
  assert.match(result!.context, /do not\s+ask which video/i);
  assert.match(result!.context, /do not reanalyze now/i);
});

test("saved-video follow-up does not silently reopen old media after a topic change", async () => {
  const newTopic: Message[] = [...originalTurn, {
    id: "fbb954e4-08b9-4fee-9277-32999df579c0",
    chatId: originalChat, role: "user", content: "New topic: write a recipe for soup",
    createdAt: "2026-10-11T16:41:00Z",
  }];
  assert.equal(savedVideoFollowUpAnchor("Does it include onions?", newTopic, 0), null);
  assert.equal(savedVideoFollowUpAnchor("Write a proposal", originalTurn, 0), null);
  assert.equal(savedVideoFollowUpAnchor("Does it include something?", originalTurn, 1), null);
  assert.equal(savedVideoFollowUpAnchor("How many appointments do I have tomorrow?", originalTurn, 0), null);
});

test("saved-video evidence retrieval refuses a different clip and stale pre-upload analysis", async () => {
  const different = await loadSavedVideoFollowUp({
    actorId: originalActor, chatId: originalChat,
    message: "Does it show the ending?", history: originalTurn, freshAttachmentCount: 0,
  }, async () => [{ ...completedEvidence, attachment_path: "chats/other/unknown.source" }]);
  assert.equal(different, null);
  const stale = await loadSavedVideoFollowUp({
    actorId: originalActor, chatId: originalChat,
    message: "Does it show the ending?", history: originalTurn, freshAttachmentCount: 0,
  }, async () => [{ ...completedEvidence, submitted_at: "2026-10-11T16:20:00Z" }]);
  assert.equal(stale, null);
});

test("saved descriptions do not invent negative conclusions from an absent detail", () => {
  const result = formatSavedVideoFollowUp([completedEvidence]);
  assert.ok(result);
  assert.match(result!.context, /A detail omitted from an analysis is NOT evidence that it did not happen/);
  assert.match(result!.context, /do not guess/i);
});

test("saved video evidence is loaded before the general saved-file selector", () => {
  const source = readFileSync("app/api/chat/route.ts", "utf8");
  const lookup = source.indexOf("await loadSavedVideoFollowUp({");
  const decision = source.indexOf("const attachmentDecision: AttachmentDecision = timelineActive");
  const selector = source.indexOf("await selectStoredAttachments(", decision);
  assert.ok(lookup >= 0 && decision > lookup && selector > decision);
  assert.match(source.slice(decision, selector), /timelineSelection\.clarification/);
  assert.match(source.slice(decision, selector), /\(mediaMemory \|\| savedVideoFollowUp\)/);
  assert.match(source.slice(decision, selector), /mediaMemory\?\.decision \?\? \{ method: "none", selections: \[\] \}/);
  assert.match(source, /personaForGeneration \+= "\\n\\n" \+ savedVideoFollowUp\.context/);
  const loader = readFileSync("lib/chat/saved-video-observations.ts", "utf8");
  assert.match(loader, /\.eq\("actor_id", params.actorId\)/);
  assert.match(loader, /\.eq\("target_chat_id", params.chatId\)/);
  assert.match(loader, /\.in\("attachment_path", params.attachmentPaths\)/);
});

test("Claude sees both entire video reports even if Grok's frame review is shorter", async () => {
  const distinctiveEnding = "UNIQUE_ENDING_RECORDED_ONLY_BY_RUNPOD";
  const runpodText = "The recording begins with a person walking through a garden. " +
    "The wind changes the direction of the nearby leaves. ".repeat(550) +
    distinctiveEnding;
  const grokText = "The person and the path are visible in the ten sampled frames.";
  const observations = buildVideoConversationEvidence({
    runpodText, grokText, runpodModel: "Qwen", grokModel: "grok-4.7",
  });
  assert.ok(runpodText.length > 22000, "guard against accidental Claude truncation");
  assert.ok(observations.includes(runpodText));
  assert.ok(observations.includes(grokText));
  assert.ok(observations.includes(distinctiveEnding));
  assert.ok(observations.indexOf("FULL RUNPOD VIDEO DESCRIPTION") <
    observations.indexOf("GROK FRAME REVIEW"));

  let prompt = "";
  const provider: LlmProvider = { name: "anthropic", listModels: async () => ["claude-fable-5-1"],
    generate: async params => {
      prompt = params.user;
      assert.deepEqual(params.attachments, []);
      assert.deepEqual(params.images, []);
      assert.deepEqual(params.history, [{ role: "assistant", content: "We were discussing garden paths." }]);
      return { provider: "anthropic", model: "claude-fable-5-1", text: "The leaves turned, just like you said." };
    },
  };
  await generateContextualVideoReply({
    provider, model: "claude-fable-5-1",
    persona: "Katie", summary: "Talking about gardens",
    history: [{ role: "assistant", content: "We were discussing garden paths." }],
    userQuestion: "[video]", observations,
  });
  assert.ok(prompt.includes(runpodText), "Claude must receive the complete original-video report");
  assert.ok(prompt.includes(grokText), "Claude must also receive the supplemental review");
  assert.ok(prompt.includes(distinctiveEnding), "distinctive ending survives final handoff");
  assert.match(prompt, /VISUAL SPECIFICITY ARE COMPLEMENTARY/);
  assert.match(prompt, /two or three most relevant concrete/i);
  assert.match(prompt, /not disposable background/i);
  assert.match(prompt, /video shared without text/i);
});

test("publisher retains RunPod when Grok succeeds, with separate source labels", () => {
  const publisher = readFileSync("lib/runpod/video-orchestration.ts", "utf8");
  assert.match(publisher, /buildVideoConversationEvidence\(\{/);
  assert.match(publisher, /runpodText,/);
  assert.match(publisher, /grokText: job\.fallback_text!\.trim\(\)/);
  assert.doesNotMatch(publisher, /text = job\.fallback_text!\.trim\(\)/);
  assert.match(publisher, /observationCharacters: answer\.length/);
});

test("missing or conflicting visual reports remain identifiable as separate evidence", () => {
  const onlyRunpod = buildVideoConversationEvidence({ runpodText: "A red truck turns right." });
  assert.match(onlyRunpod, /A red truck turns right/);
  assert.doesNotMatch(onlyRunpod, /GROK FRAME REVIEW/);
  const conflicting = buildVideoConversationEvidence({
    runpodText: "A red truck turns right.",
    grokText: "A blue truck goes straight.",
  });
  assert.match(conflicting, /A red truck turns right/);
  assert.match(conflicting, /A blue truck goes straight/);
  assert.match(conflicting, /If reports conflict/);
  assert.equal(buildVideoConversationEvidence({}), "");
});
