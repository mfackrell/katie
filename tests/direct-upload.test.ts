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
      upload: async (path: string, body: string) => { files.set(path, new Blob([body])); return { data: {}, error: null }; },
      remove: async (paths: string[]) => { paths.forEach(path => files.delete(path)); return { error: null }; },
      list: async (prefix: string) => ({ data: prefix.startsWith("chats/") ? [...files.keys()].filter(path => path.startsWith(prefix + "/")).map(path => ({ name: path.slice(prefix.length + 1) })) : [], error: null }),
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
  assert.ok(!fake.files.has(fake.signedPaths[0]), "temporary source removed after processing");
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
