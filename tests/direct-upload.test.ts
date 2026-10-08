import test from "node:test";
import assert from "node:assert/strict";
import { createStoredUploadService } from "../lib/uploads/stored-uploads";
import { uploadFilesDirect } from "../lib/uploads/direct-upload-client";
import type { FileReference } from "../lib/providers/types";

function fakeStorage() {
  const files = new Map<string, Blob>();
  const signedPaths: string[] = [];
  const downloads: string[] = [];
  let bucket: { public: boolean } | null = null;
  const storage = {
    getBucket: async () => ({ data: bucket, error: bucket ? null : { message: "Not found" } }),
    createBucket: async (_name: string, options: { public: boolean }) => { bucket = options; return { data: {}, error: null }; },
    from: () => ({
      createSignedUploadUrl: async (path: string) => { signedPaths.push(path); return { data: { signedUrl: `https://storage.example/${path}?token=scoped` }, error: null }; },
      download: async (path: string) => { downloads.push(path); return { data: files.get(path) ?? null, error: files.has(path) ? null : { message: "Not found" } }; },
      upload: async (path: string, body: BlobPart, options?: { contentType?: string }) => { files.set(path, new Blob([body], { type: options?.contentType || "" })); return { data: {}, error: null }; },
      remove: async (paths: string[]) => { paths.forEach(path => files.delete(path)); return { error: null }; },
      list: async (prefix: string, options: { offset?: number; limit?: number } = {}) => ({ data: [...files.keys()].filter(path => path.startsWith(prefix + "/")).sort().slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? 100)).map(path => ({ name: path.slice(prefix.length + 1) })), error: null }),
    }),
  };
  return { files, signedPaths, downloads, storage: storage as unknown as Parameters<typeof createStoredUploadService>[0], isPrivate: () => bucket?.public === false };
}
const reference: FileReference = {
  fileId: "document-id", fileName: "report.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  preview: "Quarterly report", attachmentKind: "text", extractionCoverage: "full", totalChunks: 1,
  extractedText: "Important source text", extractedChunks: [{ index: 0, total: 1, text: "Important source text" }],
  providerRef: { openaiFileId: "file-provider", googleFileUri: "https://provider.example/document" },
};

test("large binary uploads use private signed storage and full extraction hydrates from a compact reference", async () => {
  const fake = fakeStorage();
  const bytes = new Uint8Array(6 * 1024 * 1024); bytes[0] = 80; bytes[bytes.length - 1] = 90;
  const longText = "Important source text. ".repeat(150_000);
  const full = { ...reference, extractedText: longText, extractedChunks: [{ index: 0, total: 1, text: longText }] };
  let processed = 0;
  const service = createStoredUploadService(fake.storage, "server-only-key", { buildReferences: async files => {
    processed++;
    assert.equal(files[0].size, bytes.length); assert.equal(files[0].name, reference.fileName);
    assert.deepEqual(new Uint8Array(await files[0].arrayBuffer()), bytes);
    return [full];
  } });
  const prepared = await service.prepare({ name: reference.fileName, type: reference.mimeType, size: bytes.length });
  assert.equal(fake.isPrivate(), true);
  assert.ok(!JSON.stringify(prepared).includes("server-only-key"));
  fake.files.set(fake.signedPaths[0], new Blob([bytes]));
  const compact = await service.complete(prepared.uploadToken);
  assert.ok(JSON.stringify(compact).length < 2500);
  assert.equal(compact.extractedText, undefined); assert.equal(compact.extractedChunks, undefined);
  assert.ok(fake.files.has(fake.signedPaths[0]), "original retained until chat persistence or temporary expiration");
  assert.deepEqual(await service.hydrate([{ ...compact, preview: "forged", providerRef: { openaiFileId: "forged" } }]), [full]);
  assert.deepEqual(await service.complete(prepared.uploadToken), compact, "retry reuses the processed file");
  assert.equal(processed, 1);
});

test("signed upload receipts reject tampering, expiration, and cross-purpose use before storage access", async () => {
  const fake = fakeStorage(); let time = 1_000_000;
  const service = createStoredUploadService(fake.storage, "secret", { now: () => time, buildReferences: async () => [reference] });
  const prepared = await service.prepare({ name: "report.txt", type: "text/plain", size: 3 });
  const [body, signature] = prepared.uploadToken.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), id: "../../private" })).toString("base64url");
  await assert.rejects(service.complete(`${forged}.${signature}`), /invalid or expired/);
  await assert.rejects(service.hydrate([{ ...reference, storageToken: prepared.uploadToken }]), /invalid or expired/);
  assert.equal(fake.downloads.length, 0);
  fake.files.set(fake.signedPaths[0], new Blob(["abc"]));
  const compact = await service.complete(prepared.uploadToken);
  await assert.rejects(service.complete(compact.storageToken!), /invalid or expired/);
  time += 25 * 60 * 60 * 1000;
  await assert.rejects(service.hydrate([compact]), /invalid or expired/);
  await assert.rejects(service.complete(prepared.uploadToken), /invalid or expired/);
});

test("size and type validation runs before signing; mismatched uploads are rejected and removed", async () => {
  const fake = fakeStorage(); let processed = false;
  const service = createStoredUploadService(fake.storage, "secret", { buildReferences: async () => { processed = true; return [reference]; } });
  await assert.rejects(service.prepare({ name: "bad.exe", type: "application/octet-stream", size: 10 }), /Unsupported/);
  await assert.rejects(service.prepare({ name: "big.txt", type: "text/plain", size: 3 * 1024 * 1024 }), /too large/);
  await assert.rejects(service.prepare({ name: "empty.pdf", type: "application/pdf", size: 0 }), /Invalid attachment/);
  assert.equal(fake.signedPaths.length, 0);
  const prepared = await service.prepare({ name: "report.txt", type: "text/plain", size: 3 });
  fake.files.set(fake.signedPaths[0], new Blob(["different size"]));
  await assert.rejects(service.complete(prepared.uploadToken), /does not match/);
  assert.equal(processed, false); assert.equal(fake.files.size, 0);
});

test("legacy file references continue working and missing stored files fail explicitly", async () => {
  const fake = fakeStorage();
  const service = createStoredUploadService(fake.storage, "secret", { buildReferences: async () => [reference] });
  assert.deepEqual(await service.hydrate([reference]), [reference]);
  const prepared = await service.prepare({ name: "report.txt", type: "text/plain", size: 3 });
  await assert.rejects(service.complete(prepared.uploadToken), /did not finish/);
  fake.files.set(fake.signedPaths[0], new Blob(["abc"]));
  const compact = await service.complete(prepared.uploadToken); fake.files.clear();
  await assert.rejects(service.hydrate([compact]), /unavailable/);
});

test("browser uploads raw file bytes only to storage and sends small JSON requests to Katie", async () => {
  const file = new File([new Uint8Array(6 * 1024 * 1024)], "report.docx", { type: reference.mimeType });
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const compact = { ...reference, extractedText: undefined, extractedChunks: undefined, storageToken: "signed-reference" };
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/prepare")) return Response.json({ uploadUrl: "https://storage.example/signed", uploadToken: "receipt" });
    if (String(url).endsWith("/complete")) return Response.json({ fileReference: compact });
    return Response.json({ Key: "stored" });
  };
  const result = await uploadFilesDirect([file], () => {}, fetcher);
  assert.deepEqual(calls.map(c => c.url), ["/api/upload/prepare", "https://storage.example/signed", "/api/upload/complete"]);
  assert.equal(calls[1].init?.method, "PUT"); assert.equal(calls[1].init?.body, file);
  for (const call of [calls[0], calls[2]]) assert.ok(String(call.init?.body).length < 1000);
  assert.equal(result[0].storageToken, "signed-reference");
  assert.ok(JSON.stringify(result).length < 2500);
});

test("HTML and plain-text upload failures produce useful errors and stop before processing", async () => {
  for (const status of [413, 502]) {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      if (calls === 1) return Response.json({ uploadUrl: "https://storage.example/signed", uploadToken: "receipt" });
      return new Response("<html>hosting error</html>", { status });
    };
    await assert.rejects(uploadFilesDirect([new File(["abc"], "report.txt")], () => {}, fetcher), status === 413 ? /size limit/ : /HTTP 502/);
    assert.equal(calls, 2);
  }
  await assert.rejects(uploadFilesDirect([new File(["abc"], "report.txt")], () => {}, async () => Response.json(null, { status: 400 })), /HTTP 400/);
});

test("iPhone video uploads stay on Katie's origin and retry failed chunks", async () => {
  const file = new File([new Uint8Array(3 * 1024 * 1024 + 17)], "clip.mov", { type: "video/quicktime" });
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const progress: string[] = [];
  let transientFailure = true;
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url);
    calls.push({ path, init });
    if (path.endsWith("/prepare")) {
      assert.equal(JSON.parse(String(init?.body)).transport, "json-base64-v2");
      return Response.json({ uploadUrl: "https://storage.example/cross-origin", uploadToken: "upload-receipt", uploadId: "11111111-1111-4111-8111-111111111111" });
    }
    if (path.endsWith("/complete")) return Response.json({ fileReference: { ...reference, attachmentKind: "video", fileName: "clip.mov" } });
    assert.equal(path, "/api/upload/chunk", "video bytes must never go to a cross-origin signed URL");
    assert.equal(init?.method, "POST");
    assert.equal((init?.headers as Record<string, string>)["Content-Type"], "application/json");
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.uploadToken, "upload-receipt");
    assert.ok([0, 1].includes(payload.index));
    assert.ok(Buffer.from(payload.data, "base64").length <= 2 * 1024 * 1024);
    assert.equal(Buffer.from(payload.data, "base64").toString("base64"), payload.data);
    if (transientFailure) {
      transientFailure = false;
      throw new TypeError("Network interrupted");
    }
    return Response.json({ index: JSON.parse(String(init?.body)).index });
  };
  const refs = await uploadFilesDirect([file], message => progress.push(message), fetcher);
  assert.equal(refs[0].attachmentKind, "video");
  assert.deepEqual(calls.map(call => call.path), [
    "/api/upload/prepare", "/api/upload/chunk", "/api/upload/chunk", "/api/upload/chunk", "/api/upload/complete"
  ]);
  assert.ok(progress.some(message => message.includes("Retrying")));
  assert.ok(progress.some(message => message.includes("100%")));
});

test("server verifies, reassembles, and preserves chunked videos without changing permanent attachment workflow", async () => {
  const fake = fakeStorage();
  const size = 2 * 1024 * 1024 + 3;
  let built = 0;
  const service = createStoredUploadService(fake.storage, "server-secret", {
    buildReferences: async files => {
      built++;
      assert.equal(files[0].size, size);
      assert.equal(files[0].name, "recording.mp4");
      return [{ ...reference, fileName: "recording.mp4", mimeType: "video/mp4", attachmentKind: "video" }];
    }
  });
  const ticket = await service.prepare({ name: "recording.mp4", type: "video/mp4", size, transport: "json-base64-v2" });
  const first = new Uint8Array(2 * 1024 * 1024);
  first[0] = 7;
  await assert.rejects(service.uploadChunk(ticket.uploadToken, 0, new Uint8Array(1)), /wrong size/);
  await assert.rejects(service.uploadChunk(ticket.uploadToken, 2, new Uint8Array(1)), /Invalid attachment chunk index/);
  await service.uploadChunk(ticket.uploadToken, 0, first);
  await assert.rejects(service.complete(ticket.uploadToken), /stopped at chunk 2/);
  await service.uploadChunk(ticket.uploadToken, 0, first); // retry is idempotent
  await service.uploadChunk(ticket.uploadToken, 1, new Uint8Array([8, 9, 10]));
  const completed = await service.complete(ticket.uploadToken);
  assert.equal(completed.fileName, "recording.mp4");
  assert.equal(built, 1);
  assert.equal(fake.files.get(fake.signedPaths[0])?.size, size, "original video retained");
  assert.equal(fake.files.get(fake.signedPaths[0])?.type, "video/mp4");
  assert.ok(![...fake.files.keys()].some(path => path.startsWith("chunks/")), "temporary chunks removed");
  assert.equal((await service.complete(ticket.uploadToken)).fileName, "recording.mp4");
  assert.equal(built, 1, "completion is idempotent");
});

test("video upload failures are diagnosed by stage without sending filenames or upload tokens", async () => {
  const file = new File([new Uint8Array(1024)], "private-video.mov", { type: "video/quicktime" });
  const diagnostics: Array<Record<string, unknown>> = [];
  let attempts = 0;
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url);
    if (path === "/api/upload/prepare") return Response.json({
      uploadUrl: "https://example.storage/upload", uploadToken: "secret-ticket",
      uploadId: "22222222-2222-4222-8222-222222222222",
    });
    if (path === "/api/upload/chunk") {
      attempts++;
      return Response.json({ error: "Transfer refused by proxy" }, { status: 403 });
    }
    if (path === "/api/upload/telemetry") {
      diagnostics.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    throw new Error("Unexpected request path: " + path);
  };
  await assert.rejects(uploadFilesDirect([file], () => {}, fetcher), /part 1\/1.*Transfer refused by proxy/);
  assert.equal(attempts, 3);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].stage, "transfer");
  assert.equal(diagnostics[0].chunkIndex, 0);
  assert.equal(diagnostics[0].uploadId, "22222222-2222-4222-8222-222222222222");
  assert.ok(!JSON.stringify(diagnostics[0]).includes("private-video.mov"));
  assert.ok(!JSON.stringify(diagnostics[0]).includes("secret-ticket"));
});

test("binary upload receipts from older tabs retain their original 3 MB chunk layout", async () => {
  const fake = fakeStorage();
  const size = 3 * 1024 * 1024 + 2;
  const service = createStoredUploadService(fake.storage, "secret", {
    buildReferences: async () => [{ ...reference, attachmentKind: "video", mimeType: "video/mp4" }]
  });
  const prepared = await service.prepare({ name: "old-tab.mp4", type: "video/mp4", size });
  await service.uploadChunk(prepared.uploadToken, 0, new Uint8Array(3 * 1024 * 1024));
  await service.uploadChunk(prepared.uploadToken, 1, new Uint8Array([1, 2]));
  const completed = await service.complete(prepared.uploadToken);
  assert.equal(completed.attachmentKind, "video");
});

test("video sources survive completion, persist to the chat, and renew after temporary receipts expire", async () => {
  const fake = fakeStorage(); let time = 1_000_000; let builds = 0;
  const video = { ...reference, fileName: "scene.mp4", mimeType: "video/mp4", attachmentKind: "video" as const };
  const service = createStoredUploadService(fake.storage, "secret", { now: () => time, buildReferences: async () => {
    builds++;
    return [{ ...video, providerRef: { googleFileUri: `https://provider.example/video-${builds}` } }];
  } });
  const prepared = await service.prepare({ name: video.fileName, type: video.mimeType, size: 3 });
  fake.files.set(fake.signedPaths[0], new Blob(["mp4"]));
  const compact = await service.complete(prepared.uploadToken);
  assert.ok(fake.files.has(fake.signedPaths[0]), "video original retained until linked to a chat or expired");
  const [full] = await service.hydrate([compact]);
  const chatId = "11111111-1111-4111-8111-111111111111";
  const saved = await service.persist(chatId, full, compact.storageToken);
  assert.deepEqual(await service.restore(chatId, saved), full);
  time += 25 * 60 * 60 * 1000;
  await assert.rejects(service.hydrate([compact]), /expired/);
  fake.files.delete(fake.signedPaths[0]);
  const renewed = await service.restore(chatId, saved);
  assert.equal(renewed.providerRef?.googleFileUri, "https://provider.example/video-2");
  assert.equal(builds, 2);
  await assert.rejects(service.restore("22222222-2222-4222-8222-222222222222", saved), /unavailable/);
  await assert.rejects(service.restore(chatId, { ...saved, id: "../../another-chat" }), /Invalid/);
  await service.removeConversation(chatId);
  assert.ok(![...fake.files.keys()].some(path => path.startsWith(`chats/${chatId}/`)));
  await assert.rejects(service.restore(chatId, saved), /unavailable/);
});

test("expired legacy videos without a retained original fail explicitly instead of supplying stale access", async () => {
  const fake = fakeStorage(); let time = 1_000_000;
  const service = createStoredUploadService(fake.storage, "secret", { now: () => time });
  const chatId = "11111111-1111-4111-8111-111111111111";
  const saved = await service.persist(chatId, { ...reference, mimeType: "video/mp4" });
  time += 25 * 60 * 60 * 1000;
  await assert.rejects(service.restore(chatId, saved), /expired/);
});

test("all file types retain original bytes and a durable, paginated summary index independent of recent messages", async () => {
  const fake = fakeStorage();
  const service = createStoredUploadService(fake.storage, "secret", { buildReferences: async () => [reference] });
  const chatId = "11111111-1111-4111-8111-111111111111";
  await service.initializeCatalog(chatId, []);
  const prepared = await service.prepare({ name: "report.docx", type: reference.mimeType, size: 8 });
  fake.files.set(fake.signedPaths[0], new Blob(["original"]));
  const compact = await service.complete(prepared.uploadToken);
  const [full] = await service.hydrate([compact]);
  const saved = await service.persist(chatId, full, compact.storageToken, { description: { observedSummary: "Quarterly accounts and receivables", summaryCoverage: "full" } });
  assert.equal(saved.hasOriginal, true);
  assert.equal(await fake.files.get(`chats/${chatId}/${saved.id}.source`)!.text(), "original");
  for (let i = 0; i < 103; i++) await service.persist(chatId, { ...reference, fileName: `file-${i}.txt` }, undefined, { source: new Blob([String(i)]), description: { observedSummary: `Data ${i}` } });
  const indexed = await service.catalog(chatId);
  assert.equal(indexed.initialized, true);
  assert.equal(indexed.attachments.length, 104);
  assert.equal(indexed.attachments.find(file => file.id === saved.id)?.observedSummary, "Quarterly accounts and receivables");
  assert.equal(indexed.attachments.some(file => "extractedText" in file), false, "index never contains full bodies");
  assert.equal((await service.catalog("22222222-2222-4222-8222-222222222222")).attachments.length, 0);
  await service.removeConversation(chatId);
  assert.equal([...fake.files.keys()].filter(path => path.startsWith(`chats/${chatId}/`) || path.startsWith(`catalog/${chatId}/`)).length, 0);
});

test("actor-wide discovery shares original files across chats, isolates actors, and respects source deletion", async () => {
  const fake = fakeStorage();
  const service = createStoredUploadService(fake.storage, "secret");
  const actorA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const actorB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const sourceChat = "11111111-1111-4111-8111-111111111111";
  const newChat = "22222222-2222-4222-8222-222222222222";
  await service.initializeCatalog(actorA, [], "actor");
  const saved = await service.persist(sourceChat, reference, undefined, { actorId: actorA, source: new Blob(["original"]), description: { observedSummary: "Harbor lease proposal" } });
  const discovery = await service.catalog(actorA, "actor");
  assert.equal(discovery.initialized, true);
  assert.equal(discovery.attachments[0].chatId, sourceChat);
  assert.equal(discovery.attachments[0].actorId, actorA);
  assert.equal((await service.restore(discovery.attachments[0].chatId!, saved, actorA)).extractedText, reference.extractedText);
  assert.equal((await service.catalog(actorB, "actor")).attachments.length, 0);
  await assert.rejects(service.restore(sourceChat, saved, actorB), /different actor/);
  await service.removeConversation(newChat, actorA);
  assert.equal((await service.catalog(actorA, "actor")).attachments.length, 1, "deleting the referring chat must not delete another chat's source");
  await service.removeConversation(sourceChat, actorA);
  assert.equal((await service.catalog(actorA, "actor")).attachments.length, 0);
  await service.removeActorIndex(actorA);
  assert.equal([...fake.files.keys()].filter(path => path.startsWith(`actor-catalog/${actorA}/`)).length, 0);
});

test("video frame previews are validated, stored privately, compacted, and restored for fallback", async () => {
  const fake = fakeStorage();
  const service = createStoredUploadService(fake.storage, "secret", {
    buildReferences: async () => [{
      ...reference, fileName: "clip.mp4", mimeType: "video/mp4",
      attachmentKind: "video", providerRef: { googleFileUri: "https://provider.example/video" }
    }]
  });
  const prepared = await service.prepare({ name: "clip.mp4", type: "video/mp4", size: 3 });
  fake.files.set(fake.signedPaths[0], new Blob(["mp4"]));
  const tinyJpeg = "data:image/jpeg;base64," + Buffer.from([0xff, 0xd8, 0, 0, 0, 0, 0xff, 0xd9]).toString("base64");
  const frames = [{ timestampSeconds: 1.2, dataUrl: tinyJpeg }];
  await assert.rejects(service.complete(prepared.uploadToken, [{ timestampSeconds: 0, dataUrl: "data:text/html;base64,abcd" }]), /Invalid video frame/);
  const compact = await service.complete(prepared.uploadToken, frames);
  assert.equal(compact.videoFrames, undefined, "browser receives compact reference without heavy base64 frames");
  const [hydrated] = await service.hydrate([compact]);
  assert.deepEqual(hydrated.videoFrames, frames);
  const chat = "11111111-1111-4111-8111-111111111111";
  const descriptor = await service.persist(chat, hydrated, compact.storageToken);
  const restored = await service.restore(chat, descriptor);
  assert.deepEqual(restored.videoFrames, frames);
});

test("video client sends sampled frame evidence with completion request", async () => {
  const file = new File(["mp4"], "clip.mp4", { type: "video/mp4" });
  const jpeg = "data:image/jpeg;base64," + Buffer.from([0xff, 0xd8, 0, 0, 0, 0, 0xff, 0xd9]).toString("base64");
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body });
    if (String(url).endsWith("/prepare")) return Response.json({ uploadUrl: "https://storage.example", uploadToken: "signed" });
    if (String(url).endsWith("/chunk")) return Response.json({ index: 0 });
    if (String(url).endsWith("/complete")) return Response.json({ fileReference: { fileId: "v1", fileName: "clip.mp4", mimeType: "video/mp4", preview: "test", attachmentKind: "video" } });
    throw new Error("Unexpected upload request");
  };
  await uploadFilesDirect([file], () => {}, fetcher, async () => [{ timestampSeconds: 0.2, dataUrl: jpeg }]);
  const completed = JSON.parse(String(calls.find(c => c.url.endsWith("/complete"))?.body));
  assert.deepEqual(completed.videoFrames, [{ timestampSeconds: 0.2, dataUrl: jpeg }]);
});

test("stalled upload request is aborted, checked, and retried rather than hanging", async () => {
  const file = new File(["video data"], "clip.mp4", { type: "video/mp4" });
  let attempts = 0;
  let statusProbes = 0;
  let abortedSignal: AbortSignal | undefined;
  const progress: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url);
    if (path.endsWith("/prepare")) return Response.json({
      uploadUrl: "https://storage.example/signed", uploadId: "33333333-3333-4333-8333-333333333333",
      uploadToken: "signed-upload",
    });
    if (path.endsWith("/status")) {
      statusProbes++;
      return Response.json({ uploadId: "33333333-3333-4333-8333-333333333333",
        chunkCount: 1, uploadedIndexes: [], complete: false });
    }
    if (path.endsWith("/chunk")) {
      attempts++;
      if (attempts === 1) {
        abortedSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => {}); // Simulate webview fetch never resolving, even on abort.
      }
      return Response.json({ index: 0 });
    }
    if (path.endsWith("/complete")) return Response.json({ fileReference: { ...reference, attachmentKind: "video" } });
    throw new Error("Unexpected request " + path);
  };
  const refs = await uploadFilesDirect([file], update => progress.push(update), fetcher,
    async () => [], { chunkTimeoutMs: 20, statusTimeoutMs: 20, retryDelayMs: 0, resumeStorage: null });
  assert.equal(attempts, 2);
  assert.equal(statusProbes, 1, "probe private server state after timeout before retry");
  assert.equal(abortedSignal?.aborted, true, "timeout aborts the stalled network request");
  assert.equal(refs.length, 1);
  assert.ok(progress.some(value => value.includes("stalled")));
  assert.ok(progress.some(value => value.includes("Retrying")));
});

test("an upload acknowledgement timeout does not resend a chunk already saved by the server", async () => {
  const file = new File(["video"], "clip.mp4", { type: "video/mp4" });
  let chunkRequests = 0;
  const fetcher: typeof fetch = async (url) => {
    const path = String(url);
    if (path.endsWith("/prepare")) return Response.json({ uploadUrl: "https://storage.example", uploadToken: "receipt",
      uploadId: "33333333-3333-4333-8333-333333333333" });
    if (path.endsWith("/chunk")) {
      chunkRequests++;
      return new Promise<Response>(() => {}); // Server wrote bytes but acknowledgement disappeared.
    }
    if (path.endsWith("/status")) return Response.json({ uploadId: "33333333-3333-4333-8333-333333333333",
      chunkCount: 1, uploadedIndexes: [0], complete: false });
    if (path.endsWith("/complete")) return Response.json({ fileReference: { ...reference, attachmentKind: "video" } });
    throw new Error(path);
  };
  await uploadFilesDirect([file], () => {}, fetcher, async () => [],
    { chunkTimeoutMs: 15, statusTimeoutMs: 15, retryDelayMs: 0, resumeStorage: null });
  assert.equal(chunkRequests, 1, "do not resend a chunk that was committed server-side");
});

test("video retries resume previously transferred chunks after a failed upload using session storage", async () => {
  const file = new File([new Uint8Array(2 * 1024 * 1024 + 7)], "resumable.mp4", {
    type: "video/mp4", lastModified: 1000,
  });
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const accepted = new Set<number>();
  const posted: number[] = [];
  let prepares = 0;
  let allowSecond = false;
  let telemetryCount = 0;
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url);
    if (path.endsWith("/prepare")) {
      prepares++;
      return Response.json({
        uploadUrl: "https://storage.example/source", uploadToken: "same-upload-ticket",
        uploadId: "44444444-4444-4444-8444-444444444444",
      });
    }
    if (path.endsWith("/status")) return Response.json({
      uploadId: "44444444-4444-4444-8444-444444444444",
      chunkCount: 2, uploadedIndexes: [...accepted], complete: false,
    });
    if (path.endsWith("/chunk")) {
      const part = JSON.parse(String(init?.body)).index as number;
      posted.push(part);
      if (part === 1 && !allowSecond) return Response.json({ error: "Unavailable" }, { status: 502 });
      accepted.add(part);
      return Response.json({ index: part });
    }
    if (path.endsWith("/telemetry")) {
      telemetryCount++;
      return new Response(null, { status: 204 });
    }
    if (path.endsWith("/complete")) return Response.json({ fileReference: { ...reference, attachmentKind: "video" } });
    throw new Error(path);
  };
  const args: [{ chunkTimeoutMs: number; retryDelayMs: number; resumeStorage: typeof storage }] =
    [{ chunkTimeoutMs: 100, retryDelayMs: 0, resumeStorage: storage }];
  await assert.rejects(uploadFilesDirect([file], () => {}, fetcher, async () => [], args[0]), /part 2\/2/);
  assert.equal(telemetryCount, 1);
  assert.equal(prepares, 1);
  assert.equal(values.size, 1, "signed, expiring upload session retained until completion");
  allowSecond = true;
  const progress: string[] = [];
  const completed = await uploadFilesDirect([file], value => progress.push(value), fetcher,
    async () => [], args[0]);
  assert.equal(completed.length, 1);
  assert.equal(prepares, 1, "resumed rather than preparing and uploading again");
  assert.deepEqual(posted, [0, 1, 1, 1, 1], "previously accepted chunk 0 was skipped");
  assert.ok(progress.some(value => value.includes("Resuming")));
  assert.equal(values.size, 0, "upload ticket cleared after success");
});

test("server chunk status authenticates the upload ticket and isolates accepted chunks", async () => {
  const fake = fakeStorage();
  const service = createStoredUploadService(fake.storage, "server-only-key");
  const first = await service.prepare({ name: "clip.mp4", type: "video/mp4",
    size: 2 * 1024 * 1024 + 3, transport: "json-base64-v2" });
  const second = await service.prepare({ name: "second.mp4", type: "video/mp4",
    size: 2 * 1024 * 1024 + 3, transport: "json-base64-v2" });
  await service.uploadChunk(first.uploadToken, 0, new Uint8Array(2 * 1024 * 1024));
  const firstStatus = await service.chunkStatus(first.uploadToken);
  assert.deepEqual(firstStatus.uploadedIndexes, [0]);
  assert.equal(firstStatus.chunkCount, 2);
  assert.deepEqual((await service.chunkStatus(second.uploadToken)).uploadedIndexes, [],
    "ticket must never report another upload's chunks");
  await assert.rejects(service.chunkStatus(first.uploadToken + "tampered"), /invalid or expired/);
});


test("legacy video with no captured frames recovers private original when Gemini fails, persists for Grok", async () => {
  const fake = fakeStorage();
  const actor = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const otherActor = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const chatId = "11111111-1111-4111-8111-111111111111";
  const expectedFrames = [{
    timestampSeconds: 1.4,
    dataUrl: "data:image/jpeg;base64," + Buffer.from([0xff, 0xd8, 1, 2, 3, 4, 0xff, 0xd9]).toString("base64")
  }];
  const service = createStoredUploadService(fake.storage, "secret");
  const video = { ...reference, fileId: "legacy-v1", mimeType: "video/mp4",
    fileName: "original-screencast.mp4", attachmentKind: "video" as const, videoFrames: undefined };
  const saved = await service.persist(chatId, video, undefined, {
    source: new Blob(["actual-video-bytes"], { type: "video/mp4" }), actorId: actor
  });
  assert.equal(saved.hasOriginal, true);
  assert.equal((await service.restore(chatId, saved, actor)).videoFrames, undefined);
  let decodes = 0;
  const extract = async (source: Blob) => {
    decodes++;
    assert.equal(await source.text(), "actual-video-bytes");
    return expectedFrames;
  };
  await assert.rejects(service.recoverSavedVideoFrames(chatId, saved, otherActor, extract), /another actor/);
  assert.equal(decodes, 0);
  const recovered = await service.recoverSavedVideoFrames(chatId, saved, actor, extract);
  assert.deepEqual(recovered.videoFrames, expectedFrames);
  assert.equal(decodes, 1);
  assert.deepEqual((await service.restore(chatId, saved, actor)).videoFrames, expectedFrames);
  await service.recoverSavedVideoFrames(chatId, saved, actor, extract);
  assert.equal(decodes, 1, "video frames are cached in the saved attachment for future Grok retries");
  await assert.rejects(service.recoverSavedVideoFrames("22222222-2222-4222-8222-222222222222", saved, actor, extract), /another conversation/);
  assert.equal(decodes, 1);
});

test("older video without original cannot pretend Grok inspected decoded pixels", async () => {
  const fake = fakeStorage();
  const actor = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const chatId = "11111111-1111-4111-8111-111111111111";
  const service = createStoredUploadService(fake.storage, "secret");
  const saved = await service.persist(chatId, { ...reference, mimeType: "video/mp4",
    attachmentKind: "video" }, undefined, { actorId: actor });
  await assert.rejects(service.recoverSavedVideoFrames(chatId, saved, actor,
    async () => { throw new Error("Decoder should not start"); }), /Original video was not retained/);
});

test("newly uploaded video with lost browser previews can recover from private signed original", async () => {
  const fake = fakeStorage();
  const original = new Blob(["mp4"], { type: "video/mp4" });
  const service = createStoredUploadService(fake.storage, "secret", { buildReferences: async () => [{
    ...reference, fileId: "fresh-v1", fileName: "fresh.mp4",
    mimeType: "video/mp4", attachmentKind: "video" as const, videoFrames: undefined,
  }] });
  const prepared = await service.prepare({ name: "fresh.mp4", size: original.size, type: "video/mp4" });
  fake.files.set(fake.signedPaths[0], original);
  const finished = await service.complete(prepared.uploadToken);
  assert.equal(finished.videoFrames, undefined);
  let decoded = 0;
  const expected = [{ timestampSeconds: 0, dataUrl: "data:image/jpeg;base64," +
    Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]).toString("base64") }];
  const recovered = await service.recoverUploadVideoFrames(finished.storageToken!, async source => {
    decoded++;
    assert.equal(await source.text(), "mp4");
    return expected;
  });
  assert.deepEqual(recovered.videoFrames, expected);
  assert.deepEqual((await service.hydrate([finished]))[0].videoFrames, expected);
  await service.recoverUploadVideoFrames(finished.storageToken!, async () => {
    decoded++;
    return expected;
  });
  assert.equal(decoded, 1, "extraction runs only once per saved original");
  await assert.rejects(service.recoverUploadVideoFrames(prepared.uploadToken, async () => expected),
    /invalid or expired/, "upload credentials cannot impersonate completed references");
});
