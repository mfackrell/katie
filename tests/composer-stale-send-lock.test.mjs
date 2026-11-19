import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const panel = readFileSync("components/chat-panel.tsx", "utf8");
const start = panel.indexOf("async function isSavedChatRequestComplete(");
const end = panel.indexOf("\nfunction waitForRecoveryPoll(", start);
assert.ok(start >= 0 && end > start);
const javascript = ts.transpileModule(panel.slice(start,end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function run(status, responseOk=true) {
  let requestedUrl="";
  let requestedHeaders;
  const context = vm.createContext({
    encodeURIComponent,
    fetch: async (url, init) => {
      requestedUrl=url; requestedHeaders=init.headers;
      return {ok:responseOk,json:async()=>status};
    },
  });
  vm.runInContext(javascript+"\nglobalThis.verify = isSavedChatRequestComplete;",context);
  return {call:()=>context.verify("chat-123","request-123","session-token"),
    request:()=>({url:requestedUrl,headers:requestedHeaders})};
}

test("completed request with complete workflow and saved assistant unlocks composer",async()=>{
  const f=run({requestId:"request-123",chatId:"chat-123",status:"completed",
    workflowStatus:"completed",assistantMessageId:"saved-answer"});
  assert.equal(await f.call(),true);
  assert.match(f.request().url,/requestId=request-123&chatId=chat-123/);
  assert.equal(f.request().headers.Authorization,"Bearer session-token");
});
test("unsettled, failed, mismatched or missing-answer receipts never unlock",async()=>{
  const base={requestId:"request-123",chatId:"chat-123",status:"completed",workflowStatus:"completed",assistantMessageId:"saved-answer"};
  for(const change of [{status:"processing"},{status:"failed"},{workflowStatus:"running"},
    {workflowStatus:null},{assistantMessageId:null},{requestId:"another-request"},{chatId:"another-chat"}]){
    assert.equal(await run({...base,...change}).call(),false,JSON.stringify(change));
  }
  assert.equal(await run(base,false).call(),false);
});
test("send checks pending receipt instead of silently discarding a completed prior request",()=>{
  assert.match(panel,/const previousPending = readPendingChatRequest\(chatId\);/);
  assert.match(panel,/const finished = Boolean\(previousPending\.requestId\)/);
  assert.match(panel,/clearPendingChatRequest\(chatId\);\s*}\s*const latestComposerText/);
  assert.match(panel,/if \(!loading \|\| !answerDisplayed \|\| !chatId\) return/);
  assert.match(panel,/if \(readPendingChatRequest\(chatId\)\?\.requestId !== pending\.requestId\) return/);
  assert.match(panel,/abortControllerRef\.current\?\.abort\(\)/);
});
