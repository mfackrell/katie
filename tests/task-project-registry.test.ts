import test from "node:test";
import assert from "node:assert/strict";
import {emptyTaskProgress,applyUserToTaskProgress,applyAssistantToTaskProgress,mergeTaskProjects,taskProjectCatalog,syncTaskProgress,formatTaskProgress,isProfessionalProfileMaterial} from "../lib/chat/task-progress";

const project = (state: ReturnType<typeof emptyTaskProgress>, id:string,text:string) => applyUserToTaskProgress(state,{
  messageId:id,text,projectTransition:{action:"new",sourceQuote:text},
});

test("new question preserves source-confirmed experience in the active project",()=>{
  let state=project(emptyTaskProgress(),"a","New project: operational finance leadership");
  state=applyAssistantToTaskProgress(state,{messageId:"q",text:"Have you managed project estimates and job costs?"});
  state=applyUserToTaskProgress(state,{messageId:"fact",text:"I managed job costs and updated remaining project estimates monthly."});
  state=applyUserToTaskProgress(state,{messageId:"examples",text:"Please share 3 to 5 examples of your relevant experience."});
  assert.equal(state.projectContext?.userMessageId,"a");
  assert.equal(state.answered[0]?.userMessageId,"fact");
  assert.match(formatTaskProgress(state),/remaining project estimates/);
});

test("switching and resuming restores original requirements and unanswered questions",()=>{
  let state=project(emptyTaskProgress(),"a","New project: production operations");
  state=applyAssistantToTaskProgress(state,{messageId:"q",text:"How many production lines did you manage?"});
  state=project(state,"b","New project: lender reporting");
  assert.equal(state.pending.length,0);
  const restored=applyUserToTaskProgress(JSON.parse(JSON.stringify(state)),{messageId:"resume",text:"Return to production operations",projectTransition:{action:"resume",projectId:"a",sourceQuote:"Return to production operations"}});
  assert.equal(restored.projectContext?.userMessageId,"a");
  assert.equal(restored.pending[0]?.assistantMessageId,"q");
  assert.equal(restored.answered.length,0,"resume command is not misrecorded as a fact");
  assert.equal(restored.projects?.length,2);
});

test("routing new-project hint cannot rebind a generic question to a stale screenshot",()=>{
  const state=project(emptyTaskProgress(),"controller","New project: construction accounting and WIP");
  const next=applyUserToTaskProgress(state,{messageId:"examples",text:"Please share 3 to 5 examples of your relevant experience.",projectRelation:"new_project"});
  assert.equal(next.projectContext?.userMessageId,"controller");
});

test("project transitions fail closed on invented source or unknown identity",()=>{
  const state=project(emptyTaskProgress(),"a","New project: operations");
  for(const transition of [{action:"resume" as const,projectId:"missing",sourceQuote:"return"},{action:"new" as const,sourceQuote:"unspoken objective"}]){
    const next=applyUserToTaskProgress(state,{messageId:"ambiguous",text:"return",projectTransition:transition});
    assert.equal(next.projectContext?.userMessageId,"a");
    assert.ok(next.projectClarification);
  }
  const ambiguous=applyUserToTaskProgress(state,{messageId:"amb",text:"that other one",projectTransition:{action:"ambiguous",clarification:"Which project do you mean?"}});
  assert.equal(ambiguous.projectClarification,"Which project do you mean?");
});

test("cross-chat catalog is reference only until a validated explicit resume",()=>{
  const first=project(emptyTaskProgress(),"a","New project: manufacturing");
  const second=project(emptyTaskProgress(),"b","New project: distribution");
  const imported=mergeTaskProjects(second,(first.projects??[]).map(p=>({...p,sourceChatId:"chat-a"})));
  assert.equal(imported.projectContext?.userMessageId,"b");
  assert.equal(taskProjectCatalog(imported).length,2);
  const resumed=applyUserToTaskProgress(imported,{messageId:"return",text:"Back to manufacturing",projectTransition:{action:"resume",projectId:"a",sourceQuote:"Back to manufacturing"}});
  assert.equal(resumed.projectContext?.userMessageId,"a");
  assert.equal(resumed.projects?.find(p=>p.projectContext.userMessageId==="a")?.sourceChatId,"chat-a");
});

test("full project requirements survive serialization and cursor-window recovery",()=>{
  const text="New project: "+"requirements ".repeat(500)+"FINAL CRITICAL REQUIREMENT";
  const state=project(emptyTaskProgress(),"a",text);
  assert.equal(state.projectContext?.text,text);
  const recovered=syncTaskProgress(JSON.parse(JSON.stringify(state)),[{id:"new-q",role:"user",content:"Please give relevant examples."}]);
  assert.equal(recovered.projectContext?.text,text);
  assert.ok(recovered.projects?.some(p=>p.projectContext.text===text));
});


test("a new chat with multiple saved projects cannot silently resolve a bare continuation",()=>{
  const a=project(emptyTaskProgress(),"a","New project: operations");
  const b=project(emptyTaskProgress(),"b","New project: accounting");
  const state=mergeTaskProjects(emptyTaskProgress(),[...(a.projects??[]),...(b.projects??[])]);
  const next=applyUserToTaskProgress(state,{messageId:"continue",text:"Continue"});
  assert.equal(next.projectContext,undefined);
  assert.ok(next.projectClarification);
});

test("a later source-chat edit replaces a stale imported project snapshot",()=>{
  let origin=project(emptyTaskProgress(),"a","New project: operations");
  const b=project(emptyTaskProgress(),"b","New project: reporting");
  const copied=mergeTaskProjects(b,origin.projects??[]);
  origin=applyAssistantToTaskProgress(origin,{messageId:"new-question",text:"Have you led a process recovery?"});
  origin=applyUserToTaskProgress(origin,{messageId:"new-fact",text:"I restored monthly reporting in ten weeks."});
  const refreshed=mergeTaskProjects(copied,origin.projects??[]);
  assert.equal(refreshed.projectContext?.userMessageId,"b","refresh never switches the active project");
  const resumed=applyUserToTaskProgress(refreshed,{messageId:"resume-a",text:"Return to operations",projectTransition:{action:"resume",projectId:"a",sourceQuote:"Return to operations"}});
  assert.equal(resumed.answered[0]?.userMessageId,"new-fact");
  assert.match(formatTaskProgress(resumed),/ten weeks/);
  const originalAfterOldCopy=mergeTaskProjects(origin,copied.projects??[]);
  assert.equal(originalAfterOldCopy.answered[0]?.userMessageId,"new-fact","stale copy cannot roll back an active project");
});


test("generic examples request in a new chat requires choosing a saved application",()=>{
  const a=project(emptyTaskProgress(),"a","New project: forecasting");
  const b=project(emptyTaskProgress(),"b","New project: construction accounting");
  const state=mergeTaskProjects(emptyTaskProgress(),[...(a.projects??[]),...(b.projects??[])]);
  for(const previous of [state,applyUserToTaskProgress(state,{messageId:"hello",text:"hello"})]) {
    const next=applyUserToTaskProgress(previous,{messageId:"examples",text:"Please share 3 to 5 examples of your relevant experience."});
    assert.equal(next.projectContext,undefined);
    assert.equal(next.projectClarification,undefined,"ordinary request may start without selecting a saved application");
    assert.equal(next.projectContext,undefined,"saved project is not auto-bound");
    assert.equal(next.projects?.length,2);
  }
  const explicit=applyUserToTaskProgress(state,{messageId:"different",text:"Build a weather dashboard",projectTransition:{action:"new",sourceQuote:"Build a weather dashboard"}});
  assert.equal(explicit.projectContext?.userMessageId,"different");
  const brief=applyUserToTaskProgress(state,{messageId:"new-brief",text:"New project: product engineering leadership"});
  assert.equal(brief.projectContext?.userMessageId,"new-brief");
});

test("a seeded specialist handoff survives an empty target chat and supplies active sources to generation",()=>{
 let source=project(emptyTaskProgress(),"client-source","New project: project accounting and WIP controls for the current client");
 source=applyAssistantToTaskProgress(source,{messageId:"ask",text:"How many projects did you reconcile?"});
 source=applyUserToTaskProgress(source,{messageId:"confirmed",text:"I reconciled 35 projects and corrected $420,000 in estimates."});
 source=applyAssistantToTaskProgress(source,{messageId:"next-question",text:"What was the review cadence?"});
 const handed=syncTaskProgress(structuredClone(source),[]);
 assert.deepEqual(handed.pending,source.pending);
 assert.deepEqual(handed.answered,source.answered);
 const current=applyUserToTaskProgress(handed,{messageId:"specialist-request",text:"Give three relevant examples for this client."});
 const assembled=formatTaskProgress(current);
 assert.equal(current.projectContext?.userMessageId,"client-source");
 assert.match(assembled,/project accounting and WIP controls/);
 assert.match(assembled,/35 projects/);
 assert.match(assembled,/confirmed/);
 assert.match(assembled,/Give three relevant examples/);
});

test("unrelated standalone professional biography is not blocked by saved projects",()=>{
  const a=project(emptyTaskProgress(),"a","New project: family logistics");
  const b=project(emptyTaskProgress(),"b","New project: construction accounting");
  const state=mergeTaskProjects(emptyTaskProgress(),[...(a.projects??[]),...(b.projects??[])]);
  const profile=applyUserToTaskProgress(state,{messageId:"bio",text:"I am a fractional CFO with 25 years of experience. Please remember my professional background."});
  assert.equal(profile.projectClarification,undefined);
  assert.equal(profile.projects?.length,2);
});

test("professional profile detaches stale active project while retaining saved project data",()=>{
 const initial=project(emptyTaskProgress(),"sisters","New project: coordinate my sisters' travel");
 const profile=[
 "# Mark — Professional Identity & Operating Profile",
 "I have 25 years of experience in finance and operations leadership.",
 "## Who I Am",
 "I am an interim business executive and fractional CFO.",
 "## My Businesses",
 "I operate consulting, technology, and short-term rental companies."
 ].join("\n");
 assert.equal(isProfessionalProfileMaterial(profile),true);
 const state=applyUserToTaskProgress(initial,{messageId:"profile",text:profile});
 assert.equal(state.projectContext,null);
 assert.equal(state.projectClarification,undefined);
 assert.equal(state.objective,null,"a biography is not a deliverable");
 assert.equal(state.lastUserIntent,"conversation");
 assert.ok(state.projects?.some(p=>p.projectContext.userMessageId==="sisters"));
});
