import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const source=readFileSync("app/api/internal/itm-stage2-recovery/route.ts","utf8");
const config=JSON.parse(readFileSync("vercel.json","utf8"));
test("recovery Cron is authenticated, one-grant-bound and cannot run normal ITM work",()=>{
  assert.match(source,/if\(!assertCronAuth\(request\)\)/);
  assert.match(source,/grant\.dispatched_at!==null/);
  assert.match(source,/grant_consumed_no_valid_receipt/);
  assert.match(source,/if\(!grant\)return/);
  assert.match(source,/state\.content\.sourceMessageCount!==928/);
  assert.match(source,/maybeUpdateSummary\(CHAT\)/);
  assert.ok(source.indexOf("if(!grant)return")<source.indexOf("maybeUpdateSummary(CHAT)"));
  assert.equal(config.crons.filter(x=>x.path==="/api/internal/itm-stage2-recovery").length,1);
  assert.equal(source.includes("GROK_API_KEY"),false);
});
