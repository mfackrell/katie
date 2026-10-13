import test from "node:test";
import assert from "node:assert/strict";
import { getPendingReviewClarification, resolvePendingReviewClarification } from "../lib/chat/review-continuity";
import { isSavedDraftVerificationRetry, savedDraftReviewTask, type PendingReviewClarification } from "../lib/collaboration/review-completion";
import { applyUserToTaskProgress, emptyTaskProgress } from "../lib/chat/task-progress";
import { reviewBaseline, validateAssessment } from "../lib/collaboration/review-contract";
import type { ChatGenerateParams } from "../lib/providers/types";

type Row = { request_id: string; actor_id: string; chat_id: string; created_at: string; updated_at: string; review_audit: { status: string; pendingClarification: PendingReviewClarification } | null };
const question = "Can you provide the missing manufacturing revenue, or should I use the verified figures?";
const pending: PendingReviewClarification = {
  question, reason: "Manufacturing revenue unknown", deliverable: "CFO application response",
  candidate: "Working application draft", requirementIds: ["revenue"], createdAt: "2026-10-12T10:00:00Z",
  sourceTurns: [{ id: "turn-1", text: "Include company revenue sizes." }],
};

function installMock(rows: Row[]) {
  const original = (globalThis as Record<string, unknown>).__KATIE_SUPABASE_ADMIN_CLIENT__;
  const queries: Array<{ table: string; filters: Record<string, unknown> }> = [];
  const client = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const state = { columns: "*", limit: 100, ascending: false, sortField: "created_at" };
      queries.push({ table, filters });
      const matched = () => rows.filter(r => Object.entries(filters).every(([key,value]) =>
        (r as unknown as Record<string, unknown>)[key] === value));
      const result = () => matched().sort((a,b) => state.ascending
        ? a.created_at.localeCompare(b.created_at) : b.created_at.localeCompare(a.created_at))
        .slice(0,state.limit)
        .map(r => r as unknown as Record<string, unknown>);
      const q = {
        select(columns: string) { state.columns = columns; return q; },
        eq(field: string, value: unknown) { filters[field] = value; return q; },
        order(field: string, options: { ascending: boolean }) { state.sortField=field; state.ascending=options.ascending; return q; },
        limit(n: number) { state.limit=n; return q; },
        async maybeSingle() { return { data: result()[0] ?? null, error: null }; },
        async update(fields: Partial<Row>) {
          for(const row of matched()) Object.assign(row,fields);
          return { data: null, error: null };
        },
        then(done: (value:{data:unknown[];error:null})=>unknown) {
          return Promise.resolve({ data: result(), error: null }).then(done);
        },
      };
      return q;
    },
  };
  (globalThis as Record<string, unknown>).__KATIE_SUPABASE_ADMIN_CLIENT__ = client;
  return { queries, restore: () => {
    (globalThis as Record<string, unknown>).__KATIE_SUPABASE_ADMIN_CLIENT__ = original;
  }};
}

test("resume lookup is restricted to the same actor and chat and ignores resolved tasks", async () => {
  const rows: Row[] = [
    { request_id:"other", actor_id:"other", chat_id:"shared", created_at:"2026-10-12T11:00:00Z",updated_at:"2026-10-12T11:00:00Z",review_audit:{status:"needs_user_input",pendingClarification:pending} },
    { request_id:"prior", actor_id:"A", chat_id:"shared", created_at:"2026-10-12T10:00:00Z",updated_at:"2026-10-12T10:00:00Z",review_audit:{status:"needs_user_input",pendingClarification:{...pending}} },
  ];
  const db=installMock(rows);
  try {
    const result=await getPendingReviewClarification("A","shared");
    assert.equal(result?.requestId,"prior");
    assert.equal(result?.pending.candidate,"Working application draft");
    assert.deepEqual(result?.pending.sourceTurns,[{id:"turn-1",text:"Include company revenue sizes."}]);
    assert.equal(await getPendingReviewClarification("A","unrelated"),null);
    assert.ok(db.queries.every(q => q.table==="chat_requests"));
  } finally { db.restore(); }
});

test("pending work is resolved only after the resumed request is durably completed", async () => {
  const rows: Row[] = [{ request_id:"prior", actor_id:"A",chat_id:"chat-1",created_at:"2026-10-12T10:00:00Z",updated_at:"2026-10-12T10:00:00Z",review_audit:{status:"needs_user_input",pendingClarification:{...pending}} }];
  const db=installMock(rows);
  try {
    assert.equal((await getPendingReviewClarification("A","chat-1"))?.requestId,"prior");
    await resolvePendingReviewClarification({requestId:"prior",actorId:"A",chatId:"chat-1",resumedByRequestId:"followup"});
    assert.equal(rows[0].review_audit?.pendingClarification.resumedByRequestId,"followup");
    assert.ok(rows[0].review_audit?.pendingClarification.resolvedAt);
    assert.equal(await getPendingReviewClarification("A","chat-1"),null);
    assert.equal((await getPendingReviewClarification("other","chat-1")),null);
  } finally { db.restore(); }
});



test("historical saved draft retry recovers last new application question, not prior carve-out contract", () => {
  const actualQuestion = "Please share 3 to 5 examples of your relevant experience.";
  const saved: PendingReviewClarification = {
    question:"I saved the work, but the independent review could not be completed (Review could not be verified after the available attempts.). Should I retry verification with the saved draft?",
    reason:"Review could not be verified after the available attempts.",
    deliverable:"the original requested answer",
    candidate:"1. Global PE finance recovery.\n2. Manufacturing CFO.\n3. Business-line separation.\n4. Solar operating leadership.",
    requirementIds:[],
    createdAt:"2026-10-13T19:53:24Z",
    sourceTurns:[
      {id:"turn-1",text:"Interim CFO for global industrial client. Include audits and business separation."},
      {id:"turn-13",text:"Please share examples of carve-outs or business separations."},
      {id:"turn-15",text:"rewrite the answer"},
      {id:"turn-16",text:actualQuestion},
      {id:"latest-user",text:'This turn answers a previous clarification about the still-active deliverable. Original user turns: [...]. The user replied: yes. Continue the original task.'},
    ],
  };
  assert.equal(isSavedDraftVerificationRetry(saved,"yes"),true);
  assert.equal(isSavedDraftVerificationRetry(saved,"go ahead"),true);
  assert.equal(isSavedDraftVerificationRetry(saved,"Please share another example"),false);
  assert.equal(savedDraftReviewTask(saved),actualQuestion);
  const newTask = applyUserToTaskProgress(emptyTaskProgress(),{messageId:"resumed",text:actualQuestion});
  const params: ChatGenerateParams = {
    name:"Katie",modelId:"lead",persona:"BTG application specialist",summary:"",
    history:saved.sourceTurns!.slice(0,-1).map(turn=>({role:"user",content:turn.text})),
    user:actualQuestion,
  };
  const baseline=reviewBaseline(params,newTask);
  assert.equal(baseline.activeNewTask,true);
  assert.match(baseline.text,/ACTIVE DELIVERABLE.*Please share 3 to 5 examples/);
  const oldTaskContract={
    objective:"Answer carve-outs only",
    qualifications:["Carve-outs"],
    strongestEvidence:["Cloud and consumer segment splitting"],
    criteria:["Give only carve-out examples"],
    synthesis:{
      conclusion:"Only discuss carve-outs",emphasis:"Exclude multinational recovery.",
      dimensions:[{dimension:"Carve-outs",supportedScope:"Segment splitting",evidence:["User feedback"]}],
    },
    taskContract:{
      deliverable:"Carve-out answer",
      requirements:[
        {id:"r1",status:"active",sourceId:"turn-13",requirement:"Provide carve-out examples."},
        {id:"r2",status:"active",sourceId:"latest-user",requirement:"Give three to five examples."},
      ],
      conflicts:[],
    },
  };
  assert.throws(()=>validateAssessment(oldTaskContract,baseline.turns,{activeNewTask:true}),/completed earlier questions/);
});

test("a genuine missing-fact clarification remains distinct from a saved verification retry", () => {
  assert.equal(isSavedDraftVerificationRetry(pending,"yes"),false);
  assert.equal(savedDraftReviewTask(pending),null);
});
