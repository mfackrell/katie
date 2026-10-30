import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { modules } from "./helpers/load-project-modules.mjs";

const owner = "11111111-1111-4111-8111-111111111111";
// Each node:test file runs in its own process. Establish the verified tenant
// owner so these API fixtures exercise the authorized path.
process.env.KATIE_OWNER_AUTH_USER_ID = owner;
const guest = "99999999-9999-4999-8999-999999999999";
const actorId = "22222222-2222-4222-8222-222222222222";
const guestActorId = "44444444-4444-4444-8444-444444444444";

function harness({
  principal = { id: owner, isAnonymous: false },
  targetActorId = actorId,
  managed = false,
  ownerGuestActorIds = [guestActorId],
} = {}) {
  const calls = [];
  let savedMode = "always";
  const db = {
    rpc: async (name, args) => {
      calls.push({ type: "rpc", name, args });
      if (name === "standalone_guest_workspace") return { data: guestActorId, error: null };
      if (name === "standalone_guest_actor_ids") return { data: ownerGuestActorIds, error: null };
      throw Error("Unexpected RPC " + name);
    },
    from: table => {
      assert.equal(table, "actors");
      return { eq: (column, id) => {
        assert.equal(column, "id");
        assert.equal(id, targetActorId);
        return { update: async changes => {
          calls.push({ type: "write", changes });
          savedMode = changes.review_mode;
          return { error: null };
        } };
      } };
    },
  };
  const route = modules({
    "@/lib/standalone-accounting/auth": {
      authenticateStandalonePrincipal: async () => principal,
    },
    "@/lib/standalone-accounting/activity": { createActivityAccountingFetch: () => async () => {} },
    "@/lib/agents/store": { managedActor: async () => managed },
    "@/lib/data/supabase/admin": { getSupabaseAdminClient: () => db },
    "@/lib/data/persistence-store": {
      getActorById: async id => id === targetActorId ? {
        id, name: "Test actor", actorKind: "standard", purpose: "Existing unchanged persona", reviewMode: savedMode,
      } : null,
    },
    "@/lib/providers": { getAvailableProviders: () => [] },
    "@/lib/router/master-router": { selectControlPlaneDecisionModels: () => [] },
    "@/lib/router/actor-routing-profile": {
      createNeutralActorRoutingProfile: () => ({}),
      generateActorRoutingProfile: async () => ({}),
    },
  })("@/app/api/actors/route");
  async function patch(mode = "adaptive") {
    return route.PATCH(new Request("https://katie.example/api/actors?id=" + targetActorId, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewMode: mode }),
    }));
  }
  return { patch, calls, getMode: () => savedMode };
}

test("owner review selection saves the actor setting without editing its persona", async () => {
  const h = harness();
  const response = await h.patch("adaptive");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.actor.reviewMode, "adaptive");
  assert.equal(h.getMode(), "adaptive");
  const write = h.calls.find(call => call.type === "write");
  assert.equal(write.changes.review_mode, "adaptive");
  assert.equal("system_prompt" in write.changes, false);
  assert.equal("routing_profile" in write.changes, false);
});

test("an unrelated authenticated account cannot change another actor", async () => {
  const h = harness({ principal: { id: "33333333-3333-4333-8333-333333333333", isAnonymous: false } });
  assert.equal((await h.patch()).status, 403);
  assert.equal(h.calls.some(call => call.type === "write"), false);
});

test("anonymous users may change only their isolated guest actor", async () => {
  const allowed = harness({ principal: { id: guest, isAnonymous: true }, targetActorId: guestActorId });
  assert.equal((await allowed.patch("off")).status, 200);
  assert.equal(allowed.getMode(), "off");
  const forbidden = harness({ principal: { id: guest, isAnonymous: true } });
  assert.equal((await forbidden.patch()).status, 403);
  assert.equal(forbidden.calls.some(call => call.type === "write"), false);
});

test("owner cannot change guest actors, and managed actors still reject ordinary editing", async () => {
  const isolated = harness({ targetActorId: guestActorId });
  assert.equal((await isolated.patch()).status, 403);
  assert.equal(isolated.calls.some(call => call.type === "write"), false);
  const managed = harness({ managed: true });
  assert.equal((await managed.patch()).status, 409);
  assert.equal(managed.calls.some(call => call.type === "write"), false);
});

test("review selector stays visible in the top header next to the model controls", () => {
  const chatPanel = readFileSync("components/chat-panel.tsx", "utf8");
  const control = readFileSync("components/review-mode-control.tsx", "utf8");
  const selector = chatPanel.indexOf("<ReviewModeControl");
  const modelButton = chatPanel.indexOf("onClick={() => setShowModelControls");
  const collapsibleModels = chatPanel.indexOf('id="model-controls"');
  assert.ok(selector >= 0 && selector < modelButton && modelButton < collapsibleModels);
  assert.match(control, /aria-label=\{\`Review mode for/);
  assert.match(control, /<option value="adaptive">Adaptive<\/option>/);
  assert.match(control, /<option value="always">Always<\/option>/);
  assert.match(control, /<option value="off">Off<\/option>/);
  assert.match(control, /method: "PATCH"/);
  assert.match(control, /setMode\(body\.actor\.reviewMode\)/);
});
