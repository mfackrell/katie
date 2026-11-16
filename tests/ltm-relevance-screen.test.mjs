import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = readFileSync("lib/memory/relevance-screen.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  reportDiagnostics: true,
});
assert.equal(compiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);

function harness({ relevant = false, malformed = false, error = null, key = "dummy-key" } = {}) {
  const transmitted = [], edited = [], activities = [], constructors = [];
  const history = [
    {role:"user",content:"This is an earlier conversational question."},
    {role:"assistant",content:"Here is the earlier response."},
  ];
  class MockClient {
    constructor(options) {
      constructors.push(options);
      this.chat = {completions: {create: async options => {
        transmitted.push(options);
        if (error) throw error;
        return { choices: [{ message: { content: malformed ? '{"unknown":true}' : JSON.stringify({ relevant }) } }] };
      }}};
    }
  }
  const deps = {
    openai: { __esModule: true, default: MockClient },
    "@/lib/standalone-accounting/activity": {createActivityAccountingFetch: (provider,activity) => {
      activities.push({provider,activity});
      return async () => {throw Error("No live networking in tests");};
    }},
    "@/lib/standalone-accounting/context": {isStandaloneAccountingError: issue => issue?.terminal === true},
    "@/lib/data/persistence-store": {getRecentMessages: async () => history},
    "@/lib/memory/long-term-editor": {maybeUpdateLongTermMemory: async (...args) => edited.push(args)},
  };
  const exports = {}, module = {exports};
  const quiet = {warn(){},error(){},info(){}};
  new Function("require","module","exports","process","console",compiled.outputText)(
    path => {if (!deps[path]) throw Error("Unexpected import: " + path);return deps[path];},
    module,exports,{env: key ? {OPENAI_API_KEY: key} : {}},quiet
  );
  return {api:module.exports,transmitted,edited,activities,constructors};
}

test("routine non-durable chat sends a small relevance call but no full-memory edit", async () => {
  const h = harness({relevant:false});
  await h.api.maybeUpdateRelevantLongTermMemory("actor","chat","Hi Katie.");
  assert.equal(h.transmitted.length,1);
  assert.equal(h.transmitted[0].model,"gpt-4o-mini");
  assert.equal(h.transmitted[0].max_tokens,90);
  assert.equal(h.edited.length,0);
  assert.deepEqual(h.activities,[{provider:"openai",activity:"memory-relevance"}]);
  assert.equal(h.constructors[0].maxRetries,0);
  const prompt=h.transmitted[0].messages[1].content;
  assert.match(prompt,/LATEST HUMAN MESSAGE/);
  assert.doesNotMatch(prompt,/existingLongTermMemoryContent|LONG_TERM_MEMORY:/);
});

test("durable information invokes the existing source-verified incremental editor", async () => {
  const h = harness({relevant:true});
  const text="I reconciled the GL to project WIP every month for four years.";
  await h.api.maybeUpdateRelevantLongTermMemory("actor","chat",text);
  assert.equal(h.transmitted.length,1);
  assert.deepEqual(h.edited,[["actor","chat",text]]);
});

test("malformed result fails open so important information is not lost", async () => {
  const h = harness({malformed:true});
  await h.api.maybeUpdateRelevantLongTermMemory("actor","chat","I became CFO in 2002.");
  assert.equal(h.edited.length,1);
  assert.equal(h.transmitted.length,1);
});

test("screening transport approval denials propagate without a paid editor fallback", async () => {
  const denial=Object.assign(new Error("approval required"),{terminal:true});
  const h = harness({error:denial});
  await assert.rejects(h.api.maybeUpdateRelevantLongTermMemory("actor","chat","I prefer concise answers."),e=>e===denial);
  assert.equal(h.edited.length,0);
});

test("no screening credentials preserve rather than silently drop durable user knowledge", async () => {
  const h = harness({key:null});
  await h.api.maybeUpdateRelevantLongTermMemory("actor","chat","I have 25 years of CFO experience.");
  assert.equal(h.transmitted.length,0);
  assert.equal(h.edited.length,1);
});

test("long user messages are bounded during relevance screening", async () => {
  const h = harness({relevant:false});
  await h.api.maybeUpdateRelevantLongTermMemory("actor","chat","FIRST" + "X".repeat(15000) + "LAST");
  const prompt = h.transmitted[0].messages[1].content;
  assert.match(prompt,/FIRST/); assert.match(prompt,/LAST/);
  assert.ok(prompt.length < 9000);
  assert.equal(h.edited.length,0);
});
