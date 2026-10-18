import test from "node:test";
import assert from "node:assert/strict";
import { chooseVisualSubjects, canonicalSubject, loadVisualContinuity, describeActorVisualLongTermMemory } from "../lib/chat/visual-continuity";

const chatId = "chat-1";
const rows = [
  { subject_key: "katie", label: "Katie", source_chat_id: chatId, updated_at: "2026-10-18T14:18:20Z" },
  { subject_key: "jess", label: "Jess", source_chat_id: chatId, updated_at: "2026-10-18T14:17:25Z" },
  { subject_key: "chloe", label: "Chloe", source_chat_id: chatId, updated_at: "2026-10-18T14:16:32Z" },
  { subject_key: "client", label: "Client", source_chat_id: "other-chat", updated_at: "2026-10-17T12:00:00Z" },
];

test("individual portraits choose their original identity and do not overwrite it as a new scene", () => {
  const plan = chooseVisualSubjects("Create another photorealistic image of Chloe at the park", rows, "Katie", chatId);
  assert.deepEqual(plan.keys, ["chloe"]);
  assert.deepEqual(plan.anchor, { key: "chloe", label: "Chloe", replace: false });
});

test("corrections reference and replace the last individual identity", () => {
  const latestChloe = [rows[2], rows[1], rows[0], rows[3]];
  const plan = chooseVisualSubjects("She’s blonde…", latestChloe, "Katie", chatId);
  assert.deepEqual(plan.keys, ["chloe"]);
  assert.equal(plan.anchor?.replace, true);
});

test("Katie's identity resolves from 'you' without generating an unrelated person", () => {
  const plan = chooseVisualSubjects("Now create an image of you", rows, "Katie", chatId);
  assert.deepEqual(plan.keys, ["katie"]);
  assert.equal(plan.anchor?.key, "katie");
});

test("group portraits use same-chat cast, not unrelated actor-wide identities", () => {
  const plan = chooseVisualSubjects("Now create an image of all of you along with Ellie at the beach", rows, "Katie", chatId);
  assert.deepEqual(plan.keys, ["katie", "jess", "chloe"]);
  assert.equal(plan.anchor, null);
});

test("explicit two-person request retains both labels and never overwrites either identity", () => {
  const plan = chooseVisualSubjects("Draw Chloe and Jess together", rows, "Katie", chatId);
  assert.deepEqual(plan.keys, ["chloe", "jess"]);
  assert.equal(plan.anchor, null);
});

test("actor-wide names are available explicitly across chats without attaching an entire other cast", () => {
  const plan = chooseVisualSubjects("Generate a picture of Client", rows, "Katie", "new-chat");
  assert.deepEqual(plan.keys, ["client"]);
  assert.equal(plan.anchor?.key, "client");
});

test("unrelated image does not hijack an existing identity", () => {
  const plan = chooseVisualSubjects("Create an image of a mountain lake", rows, "Katie", chatId);
  assert.deepEqual(plan.keys, []);
  assert.equal(plan.anchor, null);
});

test("subject labels are bounded and canonicalized", () => {
  assert.equal(canonicalSubject("  Chloe!  "), "chloe");
  assert.ok(canonicalSubject("a".repeat(200)).length <= 64);
});

test("group reference retrieval supplies actual saved image bytes to the image request, not text-only history", async () => {
  const actorId = "actor-fixture";
  const imageByMessage: Record<string, string> = {
    "msg-katie": "data:image/jpeg;base64,YWJj",
    "msg-jess": "data:image/jpeg;base64,ZGVm",
    "msg-chloe": "data:image/jpeg;base64,Z2hp",
  };
  const stored = rows.slice(0, 3).map(row => ({
    actor_id: actorId, ...row, source_message_id: "msg-" + row.subject_key,
    asset_index: 0, approved: false,
  }));
  const seen: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
  const fakeClient = {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const self = {
        select(_columns: string) { return self; },
        eq(field: string, value: unknown) { filters.push([field, value]); return self; },
        order(_field: string, _options: unknown) { return self; },
        limit(_value: number) { return self; },
        async maybeSingle() {
          seen.push({ table, filters });
          const id = String(filters.find(f => f[0] === "id")?.[1] ?? "");
          return { data: id in imageByMessage ? {
            chat_id: chatId, actor_id: actorId,
            content: JSON.stringify({ text: "[Image Generated]", assets: [{ type: "image", url: imageByMessage[id] }] }),
          } : null, error: null };
        },
        then(onResolve: (value: unknown) => unknown, onReject?: (reason: unknown) => unknown) {
          seen.push({ table, filters });
          return Promise.resolve({ data: table === "visual_references" ? stored : [], error: null }).then(onResolve, onReject);
        },
      };
      return self;
    },
  };
  const scope = globalThis as unknown as { __KATIE_SUPABASE_ADMIN_CLIENT__?: unknown };
  const previous = scope.__KATIE_SUPABASE_ADMIN_CLIENT__;
  scope.__KATIE_SUPABASE_ADMIN_CLIENT__ = fakeClient;
  try {
    const plan = await loadVisualContinuity({
      actorId, chatId, prompt: "Now create an image of all of you at the beach",
      actorName: "Katie", existingImageCount: 0,
    });
    assert.deepEqual(plan.references.map(ref => ref.label), ["Katie", "Jess", "Chloe"]);
    assert.deepEqual(plan.references.map(ref => ref.image), Object.values(imageByMessage));
    assert.equal(plan.anchor, null);
    assert.match(plan.prompt, /Reference image 1: Katie/);
    assert.match(plan.prompt, /Reference image 3: Chloe/);
    assert.ok(seen.filter(call => call.table === "messages").every(call =>
      call.filters.some(filter => filter[0] === "actor_id" && filter[1] === actorId)));
  } finally {
    scope.__KATIE_SUPABASE_ADMIN_CLIENT__ = previous;
  }
});

test("canonical visual long-term memory indexes privately owned message pointers without copying image bytes", async () => {
  const seen: Array<[string, string]> = [];
  const row = {
    subject_key: "jess", label: "Jess", source_chat_id: "saved-chat",
    source_message_id: "saved-message", asset_index: 0, approved: true,
    updated_at: "2026-10-18T14:17:25Z",
  };
  const fake = {
    from(name: string) {
      assert.equal(name, "visual_references");
      const q = {
        select(_columns: string) { return q; },
        eq(field: string, value: unknown) {
          seen.push([field, String(value)]);
          return q;
        },
        order(_field: string, _options: unknown) { return q; },
        limit(_limit: number) { return q; },
        async returns() { return { data: [row], error: null }; },
      };
      return q;
    },
  };
  const globals = globalThis as unknown as { __KATIE_SUPABASE_ADMIN_CLIENT__?: unknown };
  const before = globals.__KATIE_SUPABASE_ADMIN_CLIENT__;
  globals.__KATIE_SUPABASE_ADMIN_CLIENT__ = fake;
  try {
    const manifest = await describeActorVisualLongTermMemory("actor-123");
    assert.deepEqual(seen, [["actor_id", "actor-123"]]);
    assert.match(manifest, /VISUAL_LONG_TERM_MEMORY/);
    assert.match(manifest, /"sourceMessageId":"saved-message"/);
    assert.match(manifest, /"userApproved":true/);
    assert.doesNotMatch(manifest, /data:image|base64,/);
  } finally {
    globals.__KATIE_SUPABASE_ADMIN_CLIENT__ = before;
  }
});
