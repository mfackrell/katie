import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const source=fs.readFileSync("components/chat-panel.tsx","utf8");
test("reply action is offered for assistant and user messages",()=>{
 assert.match(source,/messages\.map\(\(message\) =>/);
 assert.match(source,/Reply to \$\{message\.role\} message/);
 assert.match(source,/setReplyTo\(\{id:message\.id,role:message\.role,content:message\.content\}\)/);
});
test("reply context enters existing model request without replacing the unsent draft",()=>{
 assert.match(source,/\[Reply to \$\{replySnapshot\.role\} message \$\{replySnapshot\.id\}\]/);
 assert.match(source,/Original message:/);
 assert.match(source,/My reply:/);
 assert.match(source,/const content = reactionContent \?\?/);
 assert.match(source,/setReplyTo\(replySnapshot\)/);
 assert.match(source,/aria-label="Cancel reply"/);
});