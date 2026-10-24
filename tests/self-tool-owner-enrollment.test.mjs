import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

test("owner enrollment is pinned to configured identity, actor and chat",()=>{
  const api=readFileSync("app/api/self-tools/owner-grant/route.ts","utf8");
  assert.match(api,/KATIE_OWNER_AUTH_USER_ID/);
  assert.match(api,/KATIE_SELF_ACTOR_ID/);
  assert.match(api,/auth\/v1\/user/);
  assert.match(api,/verifiedId!==ownerId/);
  assert.match(api,/\.eq\("id",chatId\)\.eq\("actor_id",actorId\)/);
  assert.match(api,/self_tool_owner_grants/);
  assert.doesNotMatch(api,/service.role.key|NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY/i);
});
test("browser only supplies public anon key and explicit owner session",()=>{
  const client=readFileSync("lib/tools/browser-owner-session.ts","utf8");
  const panel=readFileSync("components/chat-panel.tsx","utf8");
  const auth=readFileSync("components/self-tools-owner-session.tsx","utf8");
  assert.match(client,/NEXT_PUBLIC_SUPABASE_ANON_KEY/);
  assert.doesNotMatch(client,/SERVICE_ROLE_KEY/);
  assert.match(panel,/ownerSessionBearer\(\)/);
  assert.match(panel,/Authorization: `Bearer/);
  assert.match(auth,/Authorize this chat/);
  assert.match(auth,/signInWithOtp/);
});
