import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const compiled = ts.transpileModule(readFileSync("lib/memory/assemble-context.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const sample = {
  version: 3,
  purpose: "Durable actor facts and preferences",
  entries: [
    { key: "identity.professional", value: "CFO with 25 years of experience.",
      source: "user-stated", category: "fact", confidence: "high",
      evidenceQuotes: [{ quote: "PRIVATE_QUOTE_NEVER_IN_LTM", messageId: "evidence-id-1" }],
      evidenceMessageIds: ["evidence-id-1"], lastConfirmedAt: "2026-10-23T16:49:45.095Z" },
    { key: "inference.preference", value: "Possibly prefers short conversations.",
      source: "assistant-inference", category: "pattern", confidence: "medium",
      evidenceQuotes: [{ quote: "PRIVATE_QUOTE_TWO", messageId: "evidence-id-2" }],
      evidenceMessageIds: ["evidence-id-2"], lastConfirmedAt: "2026-10-23T16:50:00.095Z" },
    { key: "correction.account", value: "Corrected value: é 🏖️\nsecond line: \\ \" quotes, $ and {braces}.",
      source: "user-stated", category: "constraint", confidence: "high",
      evidenceQuotes: [{ quote: "PRIVATE_CORRECTION_EVIDENCE", messageId: "evidence-id-3" }],
      evidenceMessageIds: ["evidence-id-3"], lastConfirmedAt: "2026-10-24T16:00:00.000Z" },
  ],
};

function harness(memory) {
  const counters = { context: 0, documents: 0, reactions: 0, events: 0, pending: 0 };
  const messages = [{ id: "m1", chatId: "chat", role: "user", content: "A current exchange", createdAt: "2026-11-17T12:00:00Z" }];
  const deps = {
    "@/lib/chat/message-reactions": {
      recentReactionContext: async () => { counters.reactions++; return "REACTION_STABLE"; },
      recentActorReactionEvents: async () => { counters.events++; return "EVENTS_STABLE"; },
    },
    "@/lib/agents/task-handoff-knowledge": { loadTaskHandoffKnowledgeContext: async () => "" },
    "@/lib/agents/policy": { currentAgentTask: () => null },
    "@/lib/chat/deliverable-standard": { getDeliverableStandardInstruction: () => "DELIVERABLE_STABLE" },
    "@/lib/chat/adaptive-response-composition": { getAdaptiveResponseCompositionInstruction: () => "ADAPTIVE_STABLE" },
    "@/lib/data/persistence-store": {
      getChatContextState: async () => {
        counters.context++;
        return { actor: { purpose: "PERSONALITY_STABLE", reviewMode: "adaptive" },
          recentMessages: messages, shortTermMemory: {},
          intermediateMemory: { summary: "INTERMEDIATE_STABLE" }, longTermMemory: memory };
      },
      listActorMemoryDocuments: async () => {
        counters.documents++;
        return [{ id: "doc1", title: "Historic", createdAt: "2026-10-01", content: "DOCUMENT_STABLE" }];
      },
      getPendingIntermediateContext: async () => { counters.pending++; return {messages:[],truncated:false}; },
    },
    "@/lib/memory/memory-contract": { MEMORY_ARCHITECTURE_GUIDE: "GUIDE_STABLE", SHORT_TERM_MESSAGE_LIMIT: 60 },
    "@/lib/memory/short-term": {
      messagesFromShortTermMemory: () => messages,
      filterConversationalMessages: value => value,
    },
    "@/lib/router/actor-routing-profile": { createNeutralActorRoutingProfile: () => ({ source: "neutral" }) },
    "@/lib/memory/history-dedup": { uniqueMessagesById: value => value },
  };
  const mod = { exports: {} };
  runInNewContext(compiled, {
    module: mod, exports: mod.exports, process: { env: {} },
    console: { info(){}, warn(){}, error(){} },
    require(name) { assert.ok(name in deps, "Unexpected API or module: " + name); return deps[name]; },
  });
  return { assemble: () => mod.exports.assembleContext("actor", "chat"), format: mod.exports.formatLongTermMemoryForPrompt, counters };
}

function block(persona) {
  const start = persona.indexOf("LONG_TERM_MEMORY:\n");
  const end = persona.indexOf("\nEND_LONG_TERM_MEMORY", start);
  assert.ok(start >= 0 && end > start);
  return persona.slice(start, end + "\nEND_LONG_TERM_MEMORY".length);
}

test("assembled LTM contains every exact key/value without ordinary evidence metadata", async () => {
  const h = harness(sample);
  const result = await h.assemble();
  const ltm = block(result.persona);
  for (const entry of sample.entries) {
    assert.ok(ltm.includes(entry.key), entry.key);
    assert.ok(ltm.includes(entry.value), entry.key + " exact value");
  }
  assert.match(ltm, /user-stated\|fact\|high/);
  assert.match(ltm, /assistant-inference\|pattern\|medium/);
  for (const excluded of ["PRIVATE_QUOTE_NEVER_IN_LTM", "PRIVATE_QUOTE_TWO", "evidence-id-1",
      "lastConfirmedAt", "evidenceMessageIds", "evidenceQuotes", "2026-10-23T16:49:45.095Z"]) {
    assert.ok(!ltm.includes(excluded), "Provenance leaked into LTM block: " + excluded);
  }
  assert.ok(result.persona.indexOf("AUTHORITATIVE ACTOR MEMORY CORRECTIONS") < result.persona.indexOf("LONG_TERM_MEMORY:\n"));
  assert.ok(result.persona.includes("CORRECTION correction.account: " + sample.entries[2].value));
  assert.ok(result.persona.includes("DOCUMENT_STABLE"));
  for (const unchanged of ["PERSONALITY_STABLE", "DELIVERABLE_STABLE", "ADAPTIVE_STABLE", "GUIDE_STABLE", "REACTION_STABLE", "EVENTS_STABLE"]) {
    assert.ok(result.persona.includes(unchanged), unchanged);
  }
  assert.equal(result.summary, "INTERMEDIATE_STABLE");
  assert.equal(result.history[0].content, "A current exchange");
  assert.deepEqual(h.counters, {context:1,documents:1,reactions:1,events:1,pending:0});
});

test("empty and malformed or extended memory shapes are lossless and safe", () => {
  const h = harness({});
  assert.match(h.format({}), /No durable long-term memory has been stored yet/);
  assert.match(h.format({entries:[]}), /No durable long-term memory entries stored/);
  for (const invalid of [
    { entries: "invalid", note: "preserve legacy knowledge" },
    { entries: [{key:"test", value:42}], version: 3 },
    { entries: [{key:"test", value:"valid", unrecognizedFact:"keep this"}] },
    { entries: [{key:"test", value:"valid"}], unexpectedRoot:"keep me" },
  ]) {
    assert.ok(h.format(invalid).includes(JSON.stringify(invalid)), "Fallback must retain all original data");
  }
});

test("actual assembled system prompt shrinks on identical 82-record fixture without losing facts", async () => {
  const memory = {
    version:3, purpose:"Durable memory",
    entries:Array.from({length:82},(_,i)=>({
      key:"record."+i, value:"Entry "+i+" has a distinct persistent factual value with enough detail to retain.",
      category:i%2?"pattern":"fact",source:i%2?"assistant-inference":"user-stated",confidence:i%2?"medium":"high",
      evidenceQuotes:[{messageId:"original-message-"+i,quote:"Verbatim source quotation repeated for provenance and audit reference."}],
      evidenceMessageIds:["original-message-"+i], lastConfirmedAt:"2026-10-23T16:49:45.095Z",
    })),
  };
  const h=harness(memory);
  const result=await h.assemble();
  const after=block(result.persona);
  const before="LONG_TERM_MEMORY:\n"+JSON.stringify(memory)+"\nEND_LONG_TERM_MEMORY";
  const originalSystemPrompt=result.persona.replace(after,before);
  const ltmReduction=before.length-after.length;
  assert.ok(ltmReduction>0);
  assert.ok(ltmReduction/before.length > 0.5, "At least 50% LTM reduction on provenance-rich fixture");
  assert.equal(originalSystemPrompt.length-result.persona.length,ltmReduction);
  for(const entry of memory.entries)assert.ok(after.includes(entry.key)&&after.includes(entry.value));
  assert.deepEqual(h.counters,{context:1,documents:1,reactions:1,events:1,pending:0});
  console.log("Measured fixture prompt characters",JSON.stringify({
    entries:memory.entries.length,ltmBefore:before.length,ltmAfter:after.length,
    systemBefore:originalSystemPrompt.length,systemAfter:result.persona.length,
    ltmReductionChars:ltmReduction,ltmReductionPercent:Number((100*ltmReduction/before.length).toFixed(1)),
  }));
});
