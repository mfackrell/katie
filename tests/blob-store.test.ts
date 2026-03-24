import test from "node:test";
import assert from "node:assert/strict";

type StoredValue = unknown;

const READ_BASE = "https://blob.example.test/store";
const API_BASE = "https://blob.vercel-storage.com";

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function parsePathFromReadUrl(url: string): string {
  return url.replace(`${READ_BASE}/`, "").split("?")[0] ?? "";
}

function parsePathFromApiUrl(url: string): string {
  return url.replace(`${API_BASE}/`, "").split("?")[0] ?? "";
}

function setupBlobMock(initial: Record<string, StoredValue> = {}): {
  store: Map<string, StoredValue>;
  calls: string[];
} {
  return setupBlobMockWithOptions(initial);
}

function setupBlobMockWithOptions(
  initial: Record<string, StoredValue> = {},
  options?: { unreadablePaths?: string[] }
): {
  store: Map<string, StoredValue>;
  calls: string[];
} {
  const store = new Map<string, StoredValue>(Object.entries(initial));
  const calls: string[] = [];
  const unreadablePaths = new Set(options?.unreadablePaths ?? []);

  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push(`${method} ${url}`);

    if (url.startsWith(`${READ_BASE}/`)) {
      const path = parsePathFromReadUrl(url);
      if (unreadablePaths.has(path) || !store.has(path)) {
        return makeJsonResponse(null, 404);
      }
      return makeJsonResponse(store.get(path));
    }

    if (url.startsWith(`${API_BASE}/`)) {
      const path = decodeURI(parsePathFromApiUrl(url));
      if (method === "PUT") {
        const rawBody = typeof init?.body === "string" ? init.body : "null";
        store.set(path, JSON.parse(rawBody));
        return makeJsonResponse({ url: `${READ_BASE}/${path}` });
      }

      if (method === "DELETE") {
        store.delete(path);
        return new Response(null, { status: 200 });
      }
    }

    throw new Error(`Unhandled fetch: ${method} ${url}`);
  }) as typeof fetch;

  return { store, calls };
}

function loadBlobStore() {
  process.env.BLOB_BASE_URL = READ_BASE;
  process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  process.env.KATIE_ALLOW_MEMORY_FALLBACK = "false";

  const modulePath = require.resolve("../lib/data/blob-store");
  delete require.cache[modulePath];
  return require("../lib/data/blob-store") as typeof import("../lib/data/blob-store");
}

test("saving an actor on empty durable store creates readable actor and registry entry", async () => {
  const { store } = setupBlobMock();
  const blobStore = loadBlobStore();

  await blobStore.saveActor({ id: "a1", name: "Actor One", purpose: "hello" });

  const actor = await blobStore.getActorById("a1");
  const actors = await blobStore.listActors();

  assert.equal(actor?.id, "a1");
  assert.equal(Array.isArray(store.get("actors/registry.json")), true);
  assert.deepEqual(actors.map((item) => item.id), ["a1"]);
});

test("getActorById falls back to actor registry when actor file is missing", async () => {
  setupBlobMock({
    "actors/registry.json": [{ id: "a-reg-only", name: "Registry Actor", purpose: "x" }],
    "actors/deleted-index.json": [],
  });
  const blobStore = loadBlobStore();

  const actor = await blobStore.getActorById("a-reg-only");
  assert.equal(actor?.id, "a-reg-only");
});

test("saving a chat creates readable chat and registry entry", async () => {
  const { store } = setupBlobMock();
  const blobStore = loadBlobStore();

  await blobStore.saveActor({ id: "a1", name: "Actor One", purpose: "hello" });
  await blobStore.saveChat({ id: "c1", actorId: "a1", title: "Chat", createdAt: "2026-03-24T00:00:00.000Z", updatedAt: "2026-03-24T00:00:00.000Z" });

  const chat = await blobStore.getChatById("c1");
  const chats = await blobStore.listChats();

  assert.equal(chat?.id, "c1");
  assert.equal(Array.isArray(store.get("chats/registry.json")), true);
  assert.deepEqual(chats.map((item) => item.id), ["c1"]);
});

test("getChatById falls back to chat registry when chat file is missing", async () => {
  setupBlobMock({
    "actors/registry.json": [{ id: "a1", name: "Actor", purpose: "x" }],
    "actors/deleted-index.json": [],
    "chats/registry.json": [{ id: "c-reg-only", actorId: "a1", title: "Registry Chat", createdAt: "2026-03-24T00:00:00.000Z", updatedAt: "2026-03-24T00:00:00.000Z" }],
  });
  const blobStore = loadBlobStore();

  const chat = await blobStore.getChatById("c-reg-only");
  assert.equal(chat?.id, "c-reg-only");
});

test("listActors uses registry even when index file is stale", async () => {
  setupBlobMock({
    "actors/registry.json": [{ id: "a-reg", name: "Registry", purpose: "x" }],
    "actors/index.json": ["a-index-only"],
    "actors/a-reg.json": { id: "a-reg", name: "Registry", purpose: "x" },
    "actors/a-index-only.json": { id: "a-index-only", name: "IndexOnly", purpose: "y" },
  });
  const blobStore = loadBlobStore();

  const actors = await blobStore.listActors();
  assert.deepEqual(actors.map((item) => item.id), ["a-reg"]);
});

test("listChats uses registry even when index file is stale", async () => {
  setupBlobMock({
    "actors/registry.json": [{ id: "a1", name: "Actor", purpose: "x" }],
    "chats/registry.json": [{ id: "c-reg", actorId: "a1", title: "Registry Chat", createdAt: "2026-03-24T00:00:00.000Z", updatedAt: "2026-03-24T00:00:00.000Z" }],
    "chats/index.json": ["c-index-only"],
    "chats/c-index-only.json": { id: "c-index-only", actorId: "a1", title: "Index", createdAt: "2026-03-24T00:00:00.000Z", updatedAt: "2026-03-24T00:00:00.000Z" },
  });
  const blobStore = loadBlobStore();

  const chats = await blobStore.listChats();
  assert.deepEqual(chats.map((item) => item.id), ["c-reg"]);
});

test("deleting actors and chats keeps registries consistent", async () => {
  const { store } = setupBlobMock();
  const blobStore = loadBlobStore();

  await blobStore.saveActor({ id: "a1", name: "Actor One", purpose: "hello" });
  await blobStore.saveActor({ id: "a2", name: "Actor Two", purpose: "hello" });
  await blobStore.saveChat({ id: "c1", actorId: "a1", title: "Chat 1", createdAt: "2026-03-24T00:00:00.000Z", updatedAt: "2026-03-24T00:00:00.000Z" });
  await blobStore.saveChat({ id: "c2", actorId: "a2", title: "Chat 2", createdAt: "2026-03-24T00:00:00.000Z", updatedAt: "2026-03-24T00:00:00.000Z" });

  await blobStore.deleteActorsById(["a1"]);
  await blobStore.deleteChatById("c2");

  assert.deepEqual((store.get("actors/registry.json") as Array<{ id: string }>).map((item) => item.id), ["a2"]);
  assert.deepEqual((store.get("chats/registry.json") as Array<{ id: string }>).map((item) => item.id), []);
  assert.deepEqual(store.get("actors/deleted-index.json"), ["a1"]);
});

test("path-map absence does not break actor/chat/message reads", async () => {
  setupBlobMock();
  const blobStore = loadBlobStore();

  await blobStore.saveActor({ id: "a1", name: "Actor", purpose: "hi" });
  await blobStore.saveChat({ id: "c1", actorId: "a1", title: "Chat", createdAt: "2026-03-24T00:00:00.000Z", updatedAt: "2026-03-24T00:00:00.000Z" });
  await blobStore.saveMessage("c1", { id: "m1", role: "user", content: "hello" });

  const actor = await blobStore.getActorById("a1");
  const chat = await blobStore.getChatById("c1");
  const messages = await blobStore.getMessages("c1");

  assert.equal(actor?.id, "a1");
  assert.equal(chat?.id, "c1");
  assert.equal(messages.length, 1);
});

test("saveActor throws when authoritative actor registry write is not durably readable", async () => {
  setupBlobMockWithOptions({}, { unreadablePaths: ["actors/registry.json"] });
  const blobStore = loadBlobStore();

  await assert.rejects(
    blobStore.saveActor({ id: "a1", name: "Actor One", purpose: "hello" }),
    /Durable write verification failed/
  );
});

test("saveChat throws when authoritative chat registry write is not durably readable", async () => {
  setupBlobMockWithOptions({}, { unreadablePaths: ["chats/registry.json"] });
  const blobStore = loadBlobStore();
  await blobStore.saveActor({ id: "a1", name: "Actor One", purpose: "hello" });

  await assert.rejects(
    blobStore.saveChat({
      id: "c1",
      actorId: "a1",
      title: "Chat",
      createdAt: "2026-03-24T00:00:00.000Z",
      updatedAt: "2026-03-24T00:00:00.000Z",
    }),
    /Durable write verification failed/
  );
});
