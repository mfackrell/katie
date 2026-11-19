import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
const panel=readFileSync("components/chat-panel.tsx","utf8");
const start=panel.indexOf("async function isSavedChatRequestTerminalFailure(");
const end=panel.indexOf("\nfunction waitForRecoveryPoll(",start);
assert.ok(start>=0&&end>start);
const js=ts.transpileModule(panel.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
function verify(payload,ok=true){
 const sandbox=vm.createContext({encodeURIComponent,fetch:async()=>({ok,json:async()=>payload})});
 vm.runInContext(js+"\nglobalThis.verify=isSavedChatRequestTerminalFailure;",sandbox);
 return sandbox.verify("chat-id","request-id");
}
const base={requestId:"request-id",chatId:"chat-id",status:"failed",workflowStatus:"failed"};
test("terminal failure of exact request and workflow safely releases previous send lock",async()=>{
 assert.equal(await verify(base),true);
 assert.match(panel,/const terminalFailure = !finished && Boolean\(previousPending\.requestId\)/);
 assert.match(panel,/if \(\(!finished && !terminalFailure\) \|\|/);
});
test("never unlock for incomplete, uncertain, paused, mismatched or unavailable status",async()=>{
 for(const change of [{status:"completed"},{status:"processing"},{workflowStatus:"running"},{workflowStatus:"paused"},{workflowStatus:null},{requestId:"wrong"},{chatId:"wrong"}]){
  assert.equal(await verify({...base,...change}),false,JSON.stringify(change));
 }
 assert.equal(await verify(base,false),false);
});
