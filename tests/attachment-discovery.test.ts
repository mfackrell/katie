import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import * as XLSX from "xlsx";
import { selectStoredAttachments, loadSelectedAttachmentSources, rankAttachmentCandidates } from "../lib/chat/attachment-selection";
import { attachmentAccessContext, type ConversationAttachment } from "../lib/chat/attachment-continuity";
import { buildFileReferences } from "../lib/uploads/build-file-references";
import { buildImageReference, imageFileFromDataUrl } from "../lib/uploads/image-reference";
import { sampleAttachmentText } from "../lib/uploads/attachment-observations";
import { parseTextFiles } from "../lib/uploads/parse-text-files";
import type { FileReference } from "../lib/providers/types";
import type { Message } from "../lib/types/chat";

const doc: ConversationAttachment = { id: "11111111-1111-4111-8111-111111111111", fileName: "plan.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", observedSummary: "A warehouse relocation proposal comparing Harbor and Ridge sites, with lease costs and moving schedules.", summaryCoverage: "full", createdAt: "2020-01-01" };
const sheet: ConversationAttachment = { ...doc, id: "22222222-2222-4222-8222-222222222222", fileName: "budget.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", observedSummary: "Forecast with Revenue and Expenses sheets; quarter ending September 2026." };
const full: FileReference = { fileId: doc.id, fileName: doc.fileName, mimeType: doc.mimeType, preview: "first page", extractedText: "Entire body, including the precise lease amount 92741." };

test("semantic discovery finds an older document without a filename or recent attachment history", async () => {
  const result = await selectStoredAttachments("What was the relocation proposal about?", [doc, sheet], [], async prompt => {
    assert.match(prompt, /warehouse relocation/);
    assert.match(prompt, /budget.xlsx/);
    return { selections: [{ id: doc.id, mode: "summary" }] };
  });
  let loads = 0;
  const restored = await loadSelectedAttachmentSources(result, async () => { loads++; return full; });
  assert.equal(loads, 0, "summary-only does not download the source");
  assert.equal(restored.references.length, 0);
  assert.match(attachmentAccessContext([], result.selections.map(item => item.attachment), [], restored.sourceIds), /summary only/);
});

test("precise follow-up promotes summary to source, loads it, and marks current source access", async () => {
  const result = await selectStoredAttachments("What is the exact lease amount?", [doc], [], async () => ({ selections: [{ id: doc.id, mode: "summary" }] }));
  assert.equal(result.selections[0].mode, "source");
  const restored = await loadSelectedAttachmentSources(result, async file => { assert.equal(file.id, doc.id); return full; });
  assert.equal(restored.references[0].extractedText, full.extractedText);
  assert.match(attachmentAccessContext([], [doc], [], restored.sourceIds), /source attached this turn/);
});

test("summary-only explicit requests, unknown IDs, ambiguity and unrelated topics remain safe", async () => {
  const explicit = await selectStoredAttachments("From the saved summary, quote the topic", [doc], [], async () => ({ selections: [{ id: doc.id, mode: "summary" }] }));
  assert.equal(explicit.selections[0].mode, "summary");
  const ambiguous = await selectStoredAttachments("Read that document", [doc, sheet], [], async () => ({ selections: [], clarification: "Which file do you mean?" }));
  assert.equal(ambiguous.selections.length, 0); assert.match(ambiguous.clarification!, /Which file/);
  const unrelated = await selectStoredAttachments("Tell me a joke", [doc], [], async () => ({ selections: [] }));
  assert.equal(unrelated.selections.length, 0);
  const invalid = await selectStoredAttachments("Read plan.docx", [doc], [], async () => ({ selections: [{ id: "../../other-chat", mode: "source" }] }));
  assert.equal(invalid.method, "fallback"); assert.equal(invalid.selections[0].attachment.id, doc.id);
  const missing = await loadSelectedAttachmentSources(invalid, async () => { throw new Error("deleted"); });
  assert.deepEqual(missing.unavailable, [doc.fileName]); assert.equal(missing.sourceIds.size, 0);
});

test("discovery ranks old matching summaries ahead of recent unrelated files and understands new uploads", async () => {
  const others = Array.from({ length: 100 }, (_, i) => ({ ...sheet, id: String(i), fileName: `new-${i}.xlsx`, createdAt: "2026-10-01" }));
  assert.equal(rankAttachmentCandidates("warehouse relocation lease", [doc, ...others], [])[0].id, doc.id);
  await selectStoredAttachments("Compare with the old plan", [doc], [], async prompt => { assert.match(prompt, /revised.docx/); return { selections: [{ id: doc.id, mode: "source" }] }; }, ["revised.docx"]);
});

test("active saved video frames remain available when the next turn challenges Katie's assessment", async () => {
  const source: ConversationAttachment = {
    id: "88888888-8888-4888-8888-888888888888", fileName: "ScreenRecording.mp4",
    mimeType: "video/mp4", hasOriginal: true, chatId: "chat-a", actorId: "actor-a",
    observedSummary: "An earlier inspection of the recording.", summaryCoverage: "sampled",
  };
  const conversation = [
    { id: "user-1", chatId: "chat-a", role: "user" as const, content: "Review this recording",
      createdAt: "2026-10-08T22:24:10Z", attachments: [source] },
    { id: "assistant-1", chatId: "chat-a", role: "assistant" as const,
      content: "I disagree with your assessment.", createdAt: "2026-10-08T22:24:40Z" },
  ];
  const emptySelector = async () => ({ selections: [] });

  const challenge = await selectStoredAttachments("Nineteen is an adult!", [source], conversation, emptySelector);
  assert.equal(challenge.method, "continuity");
  assert.deepEqual(challenge.selections, [{ attachment: source, mode: "source" }]);
  let reads = 0;
  const restored = await loadSelectedAttachmentSources(challenge, async selected => {
    assert.equal(selected.id, source.id);
    reads++;
    return {
      fileId: "v-unchanged", fileName: source.fileName, mimeType: source.mimeType,
      preview: "Retained video metadata", attachmentKind: "video", videoFrames: [
        { timestampSeconds: 1, dataUrl: "data:image/jpeg;base64,/9j/2Q==" },
        { timestampSeconds: 3, dataUrl: "data:image/jpeg;base64,/9j/2Q==" },
      ],
    };
  });
  assert.equal(reads, 1, "follow-up must reopen private saved video source");
  assert.equal(restored.references[0].videoFrames?.length, 2);
  assert.ok(restored.sourceIds.has(source.id));

  const stillVideo = await selectStoredAttachments("You misunderstood what was shown.", [source], [
    ...conversation,
    { id: "user-2", chatId: "chat-a", role: "user" as const,
      content: "Nineteen is an adult!", createdAt: "2026-10-08T22:25:30Z" },
    { id: "assistant-2", chatId: "chat-a", role: "assistant" as const,
      content: "I understand.", createdAt: "2026-10-08T22:25:56Z" },
  ], emptySelector);
  assert.equal(stillVideo.selections[0]?.attachment.id, source.id,
    "one intermediate correction must not discard current visual context");
});

test("video continuity never selects stale, ambiguous, cross-chat, or unrelated files", async () => {
  const video: ConversationAttachment = {
    id: "video-a", fileName: "review.mp4", mimeType: "video/mp4", chatId: "chat-a",
    hasOriginal: true, summaryCoverage: "sampled", observedSummary: "Visual observation.",
  };
  const second = { ...video, id: "video-b", fileName: "other.mp4" };
  const history = [
    { id: "user-1", chatId: "chat-a", role: "user" as const,
      content: "Inspect this clip", createdAt: "2026-10-08T22:24:00Z", attachments: [video] },
    { id: "assistant-1", chatId: "chat-a", role: "assistant" as const,
      content: "I inspected the clip.", createdAt: "2026-10-08T22:24:30Z" },
  ];
  const emptySelector = async () => ({ selections: [] });
  const cases: Array<[string, Message[], ConversationAttachment[], ConversationAttachment[]]> = [
    ["New topic: help me write a cover letter", history, [video], []],
    ["What time is it?", history, [video], []],
    ["Write me a note", history, [video], []],
    ["No, that's not what I asked!", history, [], []],
    ["I disagree!", [{ ...history[0], attachments: [video, second] }, history[1]], [video, second], []],
    ["I disagree!", [...history,
      { id: "u2", chatId: "chat-a", role: "user" as const,
        content: "Tell me about something new", createdAt: "2026-10-08T22:25:00Z" },
      { id: "a2", chatId: "chat-a", role: "assistant" as const,
        content: "New subject.", createdAt: "2026-10-08T22:25:05Z" }], [video], []],
  ];
  for (const [message, messages, catalog, expected] of cases) {
    const choice = await selectStoredAttachments(message, [...catalog], [...messages], emptySelector);
    assert.deepEqual(choice.selections, expected, message);
  }
  assert.equal((await selectStoredAttachments("Why did you say that?", [video], history,
    emptySelector, ["new-upload.png"])).selections.length, 0,
    "a newly attached file must take precedence over the old recording");
  assert.equal((await selectStoredAttachments("Why did you say that?", [video], history,
    async () => ({ selections: [], clarification: "Which video?" }))).selections.length, 0,
    "explicit clarification must not be silently overridden");

  const selectedSummary = await selectStoredAttachments("Why did you say that?", [video], history,
    async () => ({ selections: [{ id: video.id, mode: "summary" }] }));
  assert.equal(selectedSummary.selections[0].mode, "source",
    "a contextual question about visible evidence requires the actual source");
  const summaryOnly = await selectStoredAttachments("From the saved summary only, describe the clip", [video], history,
    async () => ({ selections: [{ id: video.id, mode: "summary" }] }));
  assert.equal(summaryOnly.selections[0].mode, "summary",
    "an explicit summary-only request must remain summary-only");
});


test("unrelated creative continuation does not inherit video, even when Gemini selector mistakenly picks it", async () => {
  const video: ConversationAttachment = {
    id: "00000000-0000-4000-8000-000000000015",
    fileName: "ScreenRecording_10-08-2026 17-42-45_1.mp4",
    mimeType: "video/mp4",
    chatId: "current-chat", actorId: "current-actor",
    conversationUsage: "uploaded",
    hasOriginal: true,
    summaryCoverage: "sampled",
  };
  const history = [
    { id: "m1", chatId: "current-chat", role: "user" as const,
      content: "Review this recording", attachments: [video],
      createdAt: "2026-10-08T23:20:00Z" },
    { id: "m2", chatId: "current-chat", role: "assistant" as const,
      content: "I reviewed the recording.", createdAt: "2026-10-08T23:21:00Z" },
  ];
  const mistakenSelector = async () => ({
    selections: [{ id: video.id, mode: "source" as const }]
  });
  for (const message of [
    "Excellent. But you can get even dirtier and more creative",
    "You are repeating yourself. Be creative and give me ACTUAL original ideas.",
    "Write me a more creative story.",
    "What time is it?",
    "Tell me a joke.",
    "Generate a video of a sunset.",
    "What are video codecs?",
  ]) {
    const result = await selectStoredAttachments(message, [video], history, mistakenSelector);
    assert.deepEqual(result.selections, [], message);
    let sourceReads = 0;
    const restored = await loadSelectedAttachmentSources(result, async () => {
      sourceReads++;
      throw new Error("Unrelated messages must not reopen any private video source");
    });
    assert.equal(sourceReads, 0, "the source must not be opened for an unrelated request");
    assert.equal(restored.references.length, 0);
  }
});

test("implicit continuity requires original visual anchor; automatic attachments never renew themselves", async () => {
  const video: ConversationAttachment = {
    id: "00000000-0000-4000-8000-000000000016",
    fileName: "ScreenRecording.mp4", mimeType: "video/mp4",
    conversationUsage: "contextual", chatId: "current-chat",
  };
  const contaminated = [
    { id: "m1", chatId: "current-chat", role: "user" as const,
      content: "Excellent. But you can be more creative", attachments: [video],
      createdAt: "2026-10-08T23:47:48Z" },
    { id: "m2", chatId: "current-chat", role: "assistant" as const,
      content: "Sure.", createdAt: "2026-10-08T23:48:00Z" },
  ];
  const ignored = await selectStoredAttachments("Why is that?", [video], contaminated,
    async () => ({ selections: [{ id: video.id, mode: "source" }] }));
  assert.deepEqual(ignored.selections, [], "automatically attached videos cannot become new anchors");

  const explicit = { ...video, conversationUsage: "uploaded" as const };
  const grounded = await selectStoredAttachments("Why did you say that?", [explicit], [
    { ...contaminated[0], content: "Look at this recording", attachments: [explicit] },
    contaminated[1],
  ], async () => ({ selections: [] }));
  assert.equal(grounded.method, "continuity");
  assert.deepEqual(grounded.selections, [{ attachment: explicit, mode: "source" }]);

  const missed = await selectStoredAttachments("Nineteen is an adult!", [explicit], [
    { ...contaminated[0], content: "Look at this recording", attachments: [explicit] },
    contaminated[1],
  ], async () => ({ selections: [] }));
  assert.equal(missed.selections[0]?.attachment.id, video.id);

  const intentional = await selectStoredAttachments("Show me what happens in the recording", [explicit],
    contaminated, async () => ({ selections: [{ id: video.id, mode: "summary" }] }));
  assert.equal(intentional.selections[0]?.attachment.id, video.id,
    "explicit reference can reopen saved video even after subject changes");
  assert.equal(intentional.selections[0]?.mode, "source",
    "details about video should restore full visual evidence");

  const unrelatedNewAttachment = await selectStoredAttachments("Describe the picture", [explicit],
    [{ ...contaminated[0], content: "Look at this recording", attachments: [explicit] }, contaminated[1]],
    async () => ({ selections: [] }), ["new.png"]);
  assert.equal(unrelatedNewAttachment.selections.length, 0);
});

test("photos use real image content, validated decoding and provider-ready rendering", async () => {
  const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#d02020" } }).png().toBuffer();
  const file = new File([Uint8Array.from(png)], "red-square.png", { type: "image/png" });
  const [reference] = await buildFileReferences([file]);
  assert.equal(reference.attachmentKind, "image");
  assert.match(reference.imageDataUrl!, /^data:image\/png;base64,/);
  const legacy = imageFileFromDataUrl(reference.imageDataUrl!);
  const recovered = await buildImageReference(legacy);
  assert.equal(recovered.imageDataUrl, reference.imageDataUrl);
  await assert.rejects(buildImageReference(new File(["bad image"], "bad.png", { type: "image/png" })));
  assert.throws(() => imageFileFromDataUrl("https://untrusted.example/image.png"), /Invalid inline image/);
});

test("workbook extraction includes sheets beyond twenty and cell formulas", async () => {
  const workbook = XLSX.utils.book_new();
  for (let i = 1; i <= 21; i++) {
    const worksheet = XLSX.utils.aoa_to_sheet([["Revenue", "Costs"], [137, 23]]);
    worksheet.C2 = { t: "n", v: 114, f: "A2-B2" }; worksheet["!ref"] = "A1:C2";
    XLSX.utils.book_append_sheet(workbook, worksheet, `Sheet${i}`);
  }
  const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  const [parsed] = await parseTextFiles([new File([bytes], "forecast.xlsx", { type: sheet.mimeType })]);
  assert.match(parsed.text, /sheet: Sheet21/);
  assert.match(parsed.text, /C2: =A2-B2; cached value: 114/);
  assert.match(parsed.text, /Used range: A1:C2/);
});

test("large-document discovery excerpts explicitly disclose sampled coverage", () => {
  const sample = sampleAttachmentText({ ...full, extractedText: "a".repeat(90_000) + "END_MARKER" });
  assert.equal(sample.coverage, "sampled"); assert.ok(sample.text.length < 40_000); assert.match(sample.text, /END_MARKER/);
});

test("native image and scanned-PDF context reports real source access instead of preview-only denial", async () => {
  const { formatAttachmentContext } = await import("../lib/providers/attachment-context");
  const { requiresGoogleFileSource, getAttachmentSupportForProvider } = await import("../lib/chat/video-routing");
  const image = { ...full, attachmentKind: "image" as const, mimeType: "image/png", imageDataUrl: "data:image/png;base64,AAAA" };
  assert.match(formatAttachmentContext([image]), /Image pixels are supplied/);
  assert.doesNotMatch(formatAttachmentContext([image]), /intentionally excluded/);
  const pdf = { ...full, mimeType: "application/pdf", extractedText: undefined, providerRef: { googleFileUri: "https://generativelanguage.googleapis.com/v1beta/files/test" } };
  assert.equal(requiresGoogleFileSource(pdf), true);
  assert.equal(getAttachmentSupportForProvider("google", [pdf]).supported, true);
  assert.equal(getAttachmentSupportForProvider("anthropic", [pdf]).supported, false);
  assert.match(formatAttachmentContext([pdf]), /inspect the PDF directly/);
  assert.equal(requiresGoogleFileSource({ ...pdf, extractedText: "OCR text", nativeInspectionRequired: true }), true);
});

test("selector failure finds the only photo across the actor catalog instead of reusing the last spreadsheet", async () => {
  const photo = { ...doc, id: "33333333-3333-4333-8333-333333333333", fileName: "pier.png", mimeType: "image/png", observedSummary: "Red circle and the label PIER 6832" };
  const history = [{ id: "m", chatId: "c", role: "user" as const, content: "Read the formula in forecast.xlsx", createdAt: "2026-10-01", attachments: [sheet] }];
  const unavailable = async () => { throw new SyntaxError("truncated selector JSON"); };
  const result = await selectStoredAttachments("In the photo, what exact identifier is printed?", [doc, sheet, photo], history, unavailable);
  assert.equal(result.method, "fallback"); assert.equal(result.selections[0].attachment.id, photo.id); assert.equal(result.selections[0].mode, "source");
  const ambiguous = await selectStoredAttachments("Read the photo", [photo, { ...photo, id: "other-photo", fileName: "other.png" }, sheet], history, unavailable);
  assert.equal(ambiguous.selections.length, 0); assert.match(ambiguous.clarification!, /Which saved image/);
  const missing = await selectStoredAttachments("Read the photo", [sheet], history, unavailable);
  assert.equal(missing.selections.length, 0, "never substitute a different file type");
  const general = await selectStoredAttachments("What is a spreadsheet?", [sheet], history, unavailable);
  assert.equal(general.selections.length, 0, "a general definition question does not load a saved file");
});
