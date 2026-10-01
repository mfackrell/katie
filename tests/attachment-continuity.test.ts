import test from "node:test";
import assert from "node:assert/strict";
import { attachmentAccessContext, selectFollowUpAttachments, type ConversationAttachment } from "../lib/chat/attachment-continuity";
import { encodeMessageContent, parseMessageContent } from "../lib/data/persistence-store";
import { resolveVideoRoutingPolicy } from "../lib/chat/video-routing";
import type { Message } from "../lib/types/chat";

const video: ConversationAttachment = { id: "11111111-1111-4111-8111-111111111111", fileName: "holiday.mp4", mimeType: "video/mp4", observedSummary: "At 00:02 a blue boat passes a red buoy.", summaryModel: "gemini-2.5-flash" };
const doc: ConversationAttachment = { id: "22222222-2222-4222-8222-222222222222", fileName: "report.pdf", mimeType: "application/pdf" };
const user = (content: string, attachments?: ConversationAttachment[]): Message => ({ id: "m", chatId: "c", role: "user", content, createdAt: "2026-10-01T00:00:00Z", attachments });
const reply: Message = { ...user("A boat passes a buoy."), role: "assistant" };

test("message persistence round-trips attachment identity and grounded evidence without changing visible text", () => {
  const encoded = encodeMessageContent(user("This is what I'm looking for", [video]));
  const decoded = parseMessageContent(encoded);
  assert.equal(decoded.text, "This is what I'm looking for");
  assert.deepEqual(decoded.attachments, [video]);
  assert.deepEqual(parseMessageContent("old text message"), { text: "old text message" });
  assert.equal(parseMessageContent('{"text":"legacy","model":"grok"}').model, "grok");
});

test("a new request restores the relevant video from saved history and activates video routing", () => {
  const history = [user("Look at this", [video]), reply];
  const restored = selectFollowUpAttachments("what about that video would make you think that?", history);
  assert.deepEqual(restored, [video]);
  assert.equal(resolveVideoRoutingPolicy(restored.some(file => file.mimeType.startsWith("video/"))).mode, "force-google");
  assert.deepEqual(selectFollowUpAttachments("Why do you think that?", history), [video]);
  assert.deepEqual(selectFollowUpAttachments("What else did you notice?", [...history, user("Why?", restored), reply]), [video]);
});

test("topic changes stop implicit attachment reuse; explicit references select the right older media", () => {
  const history = [user("Look", [video]), reply, user("New topic: report", [doc]), reply];
  assert.deepEqual(selectFollowUpAttachments("What happened in the video?", history), [video]);
  assert.deepEqual(selectFollowUpAttachments("Summarize report.pdf", history), [doc]);
  assert.deepEqual(selectFollowUpAttachments("What is two plus two?", history), []);
  assert.deepEqual(selectFollowUpAttachments("Why is that?", [...history, user("Tell me about weather"), reply]), []);
  assert.deepEqual(selectFollowUpAttachments("Describe that video", []), [], "no cross-chat global attachment lookup");
});

test("access context preserves summary provenance and does not invent prior processing failures", () => {
  const context = attachmentAccessContext([user("Look", [video])], [video], [video.fileName]);
  assert.match(context, /blue boat/);
  assert.match(context, /summary only; source not attached this turn/);
  assert.match(context, /gemini-2.5-flash/);
  assert.match(context, /never claim it did not inspect/);
  assert.match(context, /Ask the user to reattach/);
  assert.match(attachmentAccessContext([], [video], []), /source attached this turn/);
});
