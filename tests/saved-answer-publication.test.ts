import test from "node:test";
import assert from "node:assert/strict";
import { upsertSavedAssistant } from "../lib/chat/saved-answer-publication";
import type { Message } from "../lib/types/chat";

const chatId="33333333-3333-4333-8333-333333333333";
const saved:Message={
 id:"22222222-2222-4222-8222-222222222222",chatId,
 role:"assistant",content:"A reply saved by the server.",model:"test-model",
 createdAt:"2026-11-03T20:40:27.879Z",assets:[]
};

test("persisted content is inserted once even if final and stream close both run",()=>{
 const first=upsertSavedAssistant([],saved);
 assert.equal(first.length,1);
 const next=upsertSavedAssistant(first,saved);
 assert.strictEqual(next,first,"already published canonical message should preserve identity");
 assert.deepEqual(next,[saved]);
});

test("canonical ID updates an existing message without duplicate or timestamp churn",()=>{
 const previous={...saved,content:"Incomplete",createdAt:"2026-11-03T20:40:00Z"};
 const next=upsertSavedAssistant([previous],saved);
 assert.equal(next.length,1);
 assert.equal(next[0].content,saved.content);
 assert.equal(next[0].createdAt,previous.createdAt);
});

test("stream finalization keeps existing conversation messages in place",()=>{
 const user:Message={id:"11111111-1111-4111-8111-111111111111",chatId,
  role:"user",content:"Hello",createdAt:"2026-11-03T20:40:14Z"};
 const history=upsertSavedAssistant([user],saved);
 assert.equal(history.length,2);
 assert.strictEqual(history[0],user);
 assert.equal(history[1].id,saved.id);
 assert.equal(upsertSavedAssistant(history,saved).length,2);
});
