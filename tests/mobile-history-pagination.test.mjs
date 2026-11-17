import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { modules } from "./helpers/load-project-modules.mjs";

const chatId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const ownerId = "33333333-3333-4333-8333-333333333333";
process.env.KATIE_OWNER_AUTH_USER_ID = ownerId;
const uuid = n => n.toString(16).padStart(8, "0") + "-0000-4000-8000-000000000000";
const rows = Array.from({ length: 113 }, (_, i) => ({
  id: uuid(i + 1), chat_id: chatId, actor_id: actorId, role: i % 2 ? "assistant" : "user",
  content: "Saved message " + i,
  created_at: new Date(Date.UTC(2026, 10, 17, 12, 0, Math.floor(i / 4))).toISOString(),
}));
const sortDescending = (a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id);

test("bounded message pages retrieve all saved messages with stable tie-breaks and no duplicate", async () => {
  const calls = [];
  function from(table) {
    assert.equal(table, "messages");
    const state = { fields: [], equalities: [], order: [], size: null, cursor: null };
    const q = {
      select(fields) { state.fields = fields; return q; },
      eq(field, value) { state.equalities.push([field, value]); return q; },
      order(field, options) { state.order.push([field, options]); return q; },
      limit(value) { state.size = value; return q; },
      or(expr) { state.cursor = expr; return q; },
      async maybeSingle() {
        const id = state.equalities.find(([field]) => field === "id")?.[1];
        const row = rows.find(item => item.id === id && item.chat_id === chatId);
        return { data: row ? { created_at: row.created_at } : null, error: null };
      },
      async returns() {
        calls.push(state);
        assert.deepEqual(state.order.map(([field, options]) => [field, options.ascending]), [
          ["created_at", false], ["id", false],
        ]);
        assert.deepEqual(state.equalities, [["chat_id", chatId]]);
        assert.equal(state.size, 51);
        let filtered = rows.filter(item => item.chat_id === chatId).sort(sortDescending);
        if (state.cursor) {
          const match = /^created_at\.lt\.(.*),and\(created_at\.eq\.(.*),id\.lt\.([0-9a-f-]+)\)$/.exec(state.cursor);
          assert.ok(match, "Composite cursor must match created_at then id");
          assert.equal(match[1], match[2]);
          filtered = filtered.filter(item => item.created_at < match[1] ||
            (item.created_at === match[1] && item.id < match[3]));
        }
        return { data: filtered.slice(0, state.size), error: null };
      },
    };
    return q;
  }
  const persistence = modules({
    "@/lib/data/supabase/admin": { getSupabaseAdminClient: () => ({ from }) },
    "@/lib/collaboration/review-mode": { normalizeReviewMode: () => "adaptive" },
    "@/lib/router/actor-routing-profile": {
      createNeutralActorRoutingProfile: () => ({}), normalizeActorRoutingProfile: () => ({}),
    },
    [resolve("lib/presentation/default-registry")]: { validatePresentation: () => null },
  })("@/lib/data/persistence-store");
  let before;
  let seen = [];
  for (let pageNo = 0; pageNo < 3; pageNo++) {
    const page = await persistence.getRecentMessagePage(chatId, before, 50);
    assert.ok(page.messages.length <= 50);
    if (pageNo < 2) assert.equal(page.hasOlder, true);
    else assert.equal(page.hasOlder, false);
    before = page.messages[0].id;
    seen = [...page.messages.map(message => message.id), ...seen];
  }
  assert.equal(seen.length, 113);
  assert.equal(new Set(seen).size, 113);
  assert.deepEqual(seen, [...rows].sort((a,b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)).map(row => row.id));
  assert.equal(calls.length, 3);
  await assert.rejects(() => persistence.getRecentMessagePage(chatId, uuid(99999), 50), /cursor/);
});

test("message API pages only after verifying conversation access; legacy reads stay compatible", async () => {
  let user = { id: ownerId, isAnonymous: false };
  let pageCalls = 0, fullCalls = 0;
  class Denied extends Error {}
  const route = modules({
    "@/lib/data/persistence-store": {
      getChatById: async id => id === chatId ? { id, actorId } : null,
      getRecentMessagePage: async (id, before, limit) => {
        assert.equal(id, chatId);
        assert.equal(limit, 50);
        assert.equal(before, undefined);
        pageCalls++;
        return { messages: [{ id: uuid(113), chatId, role: "assistant", content: "Latest", createdAt: rows[112].created_at }], hasOlder: true };
      },
      getMessages: async () => { fullCalls++; return [{ id: uuid(1), chatId, role: "user", content: "Legacy", createdAt: rows[0].created_at }]; },
    },
    "@/lib/standalone-accounting/auth": {
      authenticateStandalonePrincipal: async () => user,
      authorizeStandaloneCaller: async () => { throw new Denied("Not authorized"); },
      StandaloneAuthorizationError: Denied,
    },
    "@/lib/standalone-accounting/ledger": { createStandaloneLedger: () => ({}) },
    "@/lib/runpod/durable-results": { resultStore: () => { throw Error("no video jobs"); } },
    "@/lib/runpod/video-orchestration": { publishVideoChat: async () => {}, processNextGrokVideo: async () => {} },
  })("@/app/api/messages/route");
  function request(suffix = "") {
    const url = new URL("https://katie.example/api/messages?chatId=" + chatId + suffix);
    return Object.assign(new Request(url), { nextUrl: url });
  }
  const paged = await route.GET(request("&recent=1"));
  assert.equal(paged.status, 200);
  assert.equal((await paged.json()).hasOlder, true);
  assert.equal(pageCalls, 1);
  assert.equal(fullCalls, 0);
  const invalid = await route.GET(request("&recent=1&before=invalid"));
  assert.equal(invalid.status, 400);
  assert.equal(pageCalls, 1);
  const legacy = await route.GET(request());
  assert.equal(legacy.status, 200);
  assert.equal((await legacy.json()).messages[0].content, "Legacy");
  assert.equal(fullCalls, 1);
  user = { id: uuid(222), isAnonymous: true };
  const blocked = await route.GET(request("&recent=1"));
  assert.equal(blocked.status, 403);
  assert.equal(pageCalls, 1, "Guest may not read saved owner history");
});

test("mobile screens offer owner sign-in and never download the entire thread by default", () => {
  const chat = readFileSync("components/chat-panel.tsx", "utf8");
  const screens = readFileSync("components/workspace-screens.tsx", "utf8");
  const session = readFileSync("app/api/session/route.ts", "utf8");
  assert.match(chat, /visibleMessages\.map\(\(message\)/);
  assert.match(chat, /Load earlier messages/);
  assert.match(chat, /&recent=1&before=/);
  assert.match(chat, /hasOlderMessages/);
  assert.match(chat, /Retry loading conversation/);
  assert.match(screens, /This browser is in guest mode/);
  assert.match(screens, /<SelfToolsOwnerSession \/>/);
  assert.match(screens, /GuestHistoryNotice guest=\{session\.data\?\.guest\}/);
  assert.match(session, /export async function GET\(request: NextRequest\)/);
});
