import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Execute the production control-plane catch branch (not a reimplementation).
const source = fs.readFileSync("lib/router/model-intent.ts", "utf8");
const anchor = 'const isLocalUnknownHelper =';
const start = source.indexOf('    } catch (error) {', source.indexOf('async function executeControlPlaneJsonTask'));
const end = source.indexOf('\n    }\n  }\n  return null;', start);
assert.ok(start > 0 && end > start && source.slice(start,end).includes(anchor));
const catchClause = source.slice(start,end + '\n    }'.length);
const context = vm.createContext({
 Error,
 console: { warn: () => {} },
 isTerminalAttemptError: e => e?.terminal === true,
 args: { taskName: "routing-rerank" },
 sourceLabel: "openai:gpt-5-mini"
});
vm.runInContext(`globalThis.run = async function(error) { try { throw error; } ${catchClause} return "alternate"; };`,context);

test("uncertain local routing timeout continues to a distinct alternate", async () => {
 const error = Object.assign(new Error("timed out"), { code: "standalone_outcome_unknown", terminal: true });
 assert.equal(await context.run(error), "alternate");
});
test("other terminal errors still stop routing", async () => {
 for(const code of ["PROVIDER_REFUSAL","standalone_time_budget_exhausted","cancelled","owner_cancelled"]){
  const error=Object.assign(new Error(code),{code,terminal:true});
  await assert.rejects(context.run(error), e => e === error);
 }
});
test("nonterminal helper errors can already fall through", async () => {
 assert.equal(await context.run(Object.assign(new Error("invalid JSON"),{terminal:false})), "alternate");
});
test("control-plane catch never replays or transmutes provider attempt", () => {
 assert.doesNotMatch(catchClause,/\.generate\s*\(|transmit\s*\(|\.retry\s*\(/);
 assert.match(source,/remaining\.splice\(remaining\.indexOf\(candidate\), 1\)/);
});
