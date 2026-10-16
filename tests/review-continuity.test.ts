import test from "node:test";
import assert from "node:assert/strict";
import { bindPendingReviewClarification, getPendingReviewClarification, resolvePendingReviewClarification, type ReviewContinuationContext } from "../lib/chat/review-continuity";
import { buildReviewResumptionContext, candidateForVerification, isSavedDraftVerificationRetry, savedDraftReviewTask, type PendingReviewClarification } from "../lib/collaboration/review-completion";
import { applyAssistantToTaskProgress, applyUserToTaskProgress, emptyTaskProgress, rebuildTaskProgress } from "../lib/chat/task-progress";
import { reviewBaseline, validateAssessment } from "../lib/collaboration/review-contract";
import type { ChatGenerateParams } from "../lib/providers/types";

type Row = { request_id: string; actor_id: string; chat_id: string; assistant_message_id?: string | null; created_at: string; updated_at: string; review_audit: { status: string; pendingClarification: PendingReviewClarification } | null };
const question = "Can you provide the missing manufacturing revenue, or should I use the verified figures?";
const pending: PendingReviewClarification = {
  question, reason: "Manufacturing revenue unknown", deliverable: "CFO application response",
  candidate: "Working application draft", requirementIds: ["revenue"], createdAt: "2026-10-12T10:00:00Z",
  sourceTurns: [{ id: "turn-1", text: "Include company revenue sizes." }],
};

function replyContext(message = "$90M.", questionText = question): ReviewContinuationContext {
  const history = [
    { id: "task", role: "user" as const, content: "Prepare a CFO application response." },
    { id: "asked", role: "assistant" as const, content: questionText },
  ];
  return { message, history, progress: applyUserToTaskProgress(rebuildTaskProgress(history), { messageId: "reply", text: message }) };
}

function installMock(rows: Row[], options: { beforeUpdate?: () => void; updateError?: string } = {}) {
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
          options.beforeUpdate?.();
          if (options.updateError) return { data: null, error: { message: options.updateError } };
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

test("legacy resume requires the exact visible question as well as the same actor and chat", async () => {
  const rows: Row[] = [
    { request_id:"other", actor_id:"other", chat_id:"shared", created_at:"2026-10-12T11:00:00Z",updated_at:"2026-10-12T11:00:00Z",review_audit:{status:"needs_user_input",pendingClarification:pending} },
    { request_id:"prior", actor_id:"A", chat_id:"shared", assistant_message_id:"asked", created_at:"2026-10-12T10:00:00Z",updated_at:"2026-10-12T10:00:00Z",review_audit:{status:"needs_user_input",pendingClarification:{...pending}} },
  ];
  const db=installMock(rows);
  try {
    const context = replyContext();
    const result=await getPendingReviewClarification("A","shared",context);
    assert.equal(result?.requestId,"prior");
    assert.equal(result?.pending.candidate,"Working application draft");
    assert.deepEqual(result?.pending.sourceTurns,[{id:"turn-1",text:"Include company revenue sizes."}]);
    assert.equal(result?.questionMessageId,"asked");
    assert.equal(result?.continuation,"answer");
    assert.equal(await getPendingReviewClarification("A","shared"),null, "same chat without current question context cannot resume");
    assert.equal(await getPendingReviewClarification("A","unrelated",context),null);
    assert.equal(await getPendingReviewClarification("A","shared",{...context,history:[]}),null, "the legacy question must exist in the visible history");
    rows[1].assistant_message_id="unrelated-question";
    assert.equal(await getPendingReviewClarification("A","shared",context),null, "identical text under a different message ID cannot resume");
    rows[1].assistant_message_id=null;
    assert.equal(await getPendingReviewClarification("A","shared",context),null, "an audit with no recoverable question ID stays parked");
    assert.ok(db.queries.every(q => q.table==="chat_requests"));
  } finally { db.restore(); }
});

test("pending work is resolved only after the resumed request is durably completed", async () => {
  const rows: Row[] = [{ request_id:"prior", actor_id:"A",chat_id:"chat-1",assistant_message_id:"asked",created_at:"2026-10-12T10:00:00Z",updated_at:"2026-10-12T10:00:00Z",review_audit:{status:"needs_user_input",pendingClarification:{...pending}} }];
  const db=installMock(rows);
  try {
    const context = replyContext();
    assert.equal((await getPendingReviewClarification("A","chat-1",context))?.requestId,"prior");
    const input = {requestId:"prior",actorId:"A",chatId:"chat-1",resumedByRequestId:"followup"};
    assert.equal(await resolvePendingReviewClarification({...input, completed:false}),false);
    assert.equal(rows[0].review_audit?.pendingClarification.resolvedAt,undefined);
    assert.equal(await resolvePendingReviewClarification({...input, completed:true}),true);
    assert.equal(rows[0].review_audit?.pendingClarification.resumedByRequestId,"followup");
    assert.ok(rows[0].review_audit?.pendingClarification.resolvedAt);
    assert.equal(await getPendingReviewClarification("A","chat-1",context),null);
    assert.equal((await getPendingReviewClarification("other","chat-1",context)),null);
  } finally { db.restore(); }
});

test("bound clarification lookup rejects another project or task even when the question wording is identical", async () => {
  const context = replyContext();
  const bound = bindPendingReviewClarification(pending, context.progress, "asked");
  assert.deepEqual(bound.binding, { projectId:"task", taskId:"task", questionMessageId:"asked" });
  assert.equal(pending.binding, undefined, "binding must not mutate a shared audit object");
  const rows: Row[] = [{ request_id:"bound", actor_id:"A", chat_id:"chat", created_at:"2026-10-16T19:00:00Z", updated_at:"2026-10-16T19:00:00Z", review_audit:{status:"needs_user_input",pendingClarification:bound} }];
  const db=installMock(rows);
  try {
    assert.equal((await getPendingReviewClarification("A","chat",context))?.requestId,"bound");
    assert.equal(await getPendingReviewClarification("A","chat",{
      ...context, progress:{...context.progress,projectContext:{text:"A different project",userMessageId:"other-project"}},
    }),null);
    assert.equal(await getPendingReviewClarification("A","chat",{
      ...context, progress:{...context.progress,objective:{text:"A separate application question",userMessageId:"other-task"}},
    }),null);
    assert.equal(await getPendingReviewClarification("A","chat",{...context,projectRelation:"new_project"}),null);
  } finally { db.restore(); }
});

test("a terminology detour preserves the audit and an eventual answer resumes its original question", async () => {
  const termQuestion="Do you have any distribution, wholesale, or sponsor-reporting experience that isn't in your record?";
  const message="i do not have specific distribution, wholesale experience, i dont know what sporsor reporting is.";
  const context=replyContext(message,termQuestion);
  const current=bindPendingReviewClarification({...pending,question:termQuestion},context.progress,"asked");
  const rows: Row[] = [{ request_id:"current", actor_id:"A", chat_id:"chat", created_at:"2026-10-16T19:00:00Z", updated_at:"2026-10-16T19:00:00Z", review_audit:{status:"needs_user_input",pendingClarification:current} }];
  const db=installMock(rows);
  try {
    assert.equal(context.progress.pending[0]?.assistantMessageId,"asked");
    assert.equal(await getPendingReviewClarification("A","chat",context),null);
    assert.equal(rows[0].review_audit?.pendingClarification.resolvedAt,undefined);
    const explanation={id:"definition",role:"assistant" as const,content:"Sponsor reporting means reporting to the private equity owner, such as board packs, budgets and cash-flow reports."};
    const explained=applyAssistantToTaskProgress(context.progress,{messageId:explanation.id,text:explanation.content,responsePurpose:"conversation"});
    const answer="Yes, I prepared monthly board packs for private equity owners.";
    const selected=await getPendingReviewClarification("A","chat",{
      message:answer, history:[...context.history,{id:"reply",role:"user",content:message},explanation],
      progress:applyUserToTaskProgress(explained,{messageId:"fact-answer",text:answer}),
    });
    assert.equal(selected?.requestId,"current");
    assert.equal(selected?.questionMessageId,"asked");
    assert.equal(selected?.continuation,"answer");
  } finally { db.restore(); }
});

test("an old verification prompt cannot consume a reply to a newer visible question in the same chat", async () => {
  const context=replyContext("No additional distribution or wholesale experience.");
  const old={...pending, question:"Should I retry verification with the saved draft?",candidate:"Old industrial-company examples"};
  const rows: Row[] = [{ request_id:"old", actor_id:"A", chat_id:"chat", assistant_message_id:"old-question", created_at:"2026-10-13T19:53:24Z",updated_at:"2026-10-13T19:53:26.164+00:00",review_audit:{status:"needs_user_input",pendingClarification:old} }];
  const db=installMock(rows);
  try {
    assert.equal(await getPendingReviewClarification("A","chat",{
      ...context,history:[{id:"old-question",role:"assistant",content:old.question},...context.history],
    }),null);
    assert.equal(rows[0].review_audit?.pendingClarification.resumedByRequestId,undefined);
  } finally { db.restore(); }
});

test("explicit verification retry selects only the bound saved candidate", async () => {
  const retryQuestion="Should I retry verification with the saved draft?";
  const context=replyContext("retry verification with the saved draft",retryQuestion);
  const saved=bindPendingReviewClarification({...pending,question:retryQuestion,candidate:"EXACT saved draft\nwith intentional wording."},context.progress,"asked");
  const rows: Row[] = [{ request_id:"saved", actor_id:"A", chat_id:"chat", created_at:"2026-10-16T19:00:00Z", updated_at:"2026-10-16T19:00:00Z", review_audit:{status:"needs_user_input",pendingClarification:saved} }];
  const db=installMock(rows);
  try {
    const selected=await getPendingReviewClarification("A","chat",context);
    assert.equal(selected?.continuation,"verification_retry");
    assert.equal(candidateForVerification(selected?.pending ?? null,context.message,"Unexpected regenerated answer"),saved.candidate);
    assert.equal(await getPendingReviewClarification("A","chat",replyContext("No, leave it saved.",retryQuestion)),null);
  } finally { db.restore(); }
});

test("a failed or raced completion update leaves the saved draft unresolved", async () => {
  const timestamp="2026-10-13T19:53:26.164+00:00";
  const row: Row={request_id:"prior",actor_id:"A",chat_id:"chat",created_at:timestamp,updated_at:timestamp,review_audit:{status:"needs_user_input",pendingClarification:{...pending}}};
  const input={requestId:"prior",actorId:"A",chatId:"chat",resumedByRequestId:"followup",completed:true};
  const failed=installMock([row],{updateError:"temporary persistence failure"});
  try {
    assert.equal(await resolvePendingReviewClarification(input),false);
    assert.equal(row.review_audit?.pendingClarification.resolvedAt,undefined);
  } finally { failed.restore(); }
  const raced=installMock([row],{beforeUpdate:()=>{row.updated_at="2026-10-16T20:00:00Z";}});
  try {
    assert.equal(await resolvePendingReviewClarification(input),false);
    assert.equal(row.review_audit?.pendingClarification.resolvedAt,undefined);
    assert.ok(raced.queries.some(query=>query.filters.updated_at===timestamp),"the update must compare the exact version read before the race");
  } finally { raced.restore(); }
});

test("resumption instructions distinguish unknown facts from unfamiliar terminology",()=>{
  const context=buildReviewResumptionContext(pending,"I don't know what sponsor reporting means.");
  assert.match(context,/does not establish absence of experience/);
  assert.match(context,/keep the underlying question open/);
  assert.ok(!context.includes("Treat a reply of 'unknown', 'I don't know'"));
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
  assert.equal(candidateForVerification(saved,"yes","Wrong regenerated carve-out-only draft"),
    saved.candidate, "Retry verification must preserve original broad-examples draft");
  assert.equal(candidateForVerification(saved,"A separate new request","Fresh answer"),"Fresh answer");
  const newTask = applyUserToTaskProgress(emptyTaskProgress(),{messageId:"resumed",text:actualQuestion});
  const params: ChatGenerateParams = {
    name:"Katie",modelId:"lead",persona:"BTG application specialist",summary:"",
    history:saved.sourceTurns!.slice(0,-1).map(turn=>({role:"user" as const,content:turn.text})),
    user:actualQuestion,
  };
  const baseline=reviewBaseline(params,newTask);
  assert.equal(baseline.activeNewTask,true);
  assert.match(baseline.text,/ACTIVE DELIVERABLE[\s\S]*?Please share 3 to 5 examples/);
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
