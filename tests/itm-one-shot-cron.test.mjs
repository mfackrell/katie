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
  assert.match(source,/state\.content\.sourceMessageCount!==1258/);
  assert.match(source,/maybeUpdateSummary\(CHAT\)/);
  assert.match(source,/const END="271b0d79-203f-59a7-a00f-76f888d66ecc"/);
  assert.match(source,/const CURSOR="94df59b1-7104-559f-a2df-3f70a7ed38fa"/);
  assert.match(source,/const SOURCE_SHA="356cee3a87c4eba204b538bcc53e037b882f45d30428ce54d69cae5fffa99e08"/);
  assert.match(source,/runWithStandaloneAccounting/);
  assert.match(source,/\.select\("owner_id"\)/);
  assert.match(source,/\.returns<\{owner_id:string\|null\}>\(\)/);
  assert.doesNotMatch(source,/\.not\(/);
  assert.ok(source.indexOf("if(!grant)return")<source.indexOf("maybeUpdateSummary(CHAT)"));
  assert.equal(config.crons.filter(x=>x.path==="/api/internal/itm-stage2-recovery").length,1);
  assert.equal(source.includes("GROK_API_KEY"),false);
});
