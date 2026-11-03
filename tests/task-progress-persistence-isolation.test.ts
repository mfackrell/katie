import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyAssistantToTaskProgress, applyUserToTaskProgress, emptyTaskProgress,
  hasProjectAuthority, isUserWorkAssignment, mergeTaskProjects, syncTaskProgress,
  taskProjectCatalog, type TaskProgressState,
} from "../lib/chat/task-progress";
import { loadTaskProgress, loadActorTaskProjects, saveTaskProgress, verifyTaskProgressForUse } from "../lib/chat/task-progress-store";
import { selectTaskProgressPrompt } from "../lib/chat/task-progress-prompt";
import { decideResponsePolicy } from "../lib/chat/response-policy";
import { ClaudeProvider } from "../lib/providers/claude-provider";
import { runWithOrchestratorAccounting } from "../lib/standalone-accounting/context";

const actor = "f94eeb41-9bcd-4eb8-9896-bb92e5e3b5c0";
const chat = "6e6a5c19-b747-4974-9dc7-890dacd13e03";
const orphan = "d5e1d7b0-3e86-5700-a6d0-7809ee1175f6";
const casualObjective = "de7b62b8-957d-4d48-86ed-a55f993c2719";
const validProject = "74bc900c-60fd-4b61-9825-8c9a95eff54b";
const validChat = "17e296dd-8f23-4b36-8c46-df6806d497af";
const executiveBrief = [
  "# Executive Assignment: Independent Financial Review", "",
  "## Mission",
  "Conduct an independent review of the operational and financial reporting system.",
  "## Deliverables",
  "Prepare a written assessment of the findings.",
].join("\n");

function legacyState(): TaskProgressState {
  const source = { userMessageId: orphan, text:
    "Ok, fine. How about this one?\nFRESH USER-SUPPLIED SOURCE EVIDENCE (observations may be incomplete):\n[redacted legacy attachment observation]" };
  return {
    ...emptyTaskProgress(),
    projectContext: source,
    objective: { userMessageId: casualObjective, text: "a little pissy there eh katie" },
    pending: [{ id: "casual-q:1", assistantMessageId: "casual-q", index: 1,
      text: "What would you like to talk about?", projectId: orphan, taskId: casualObjective }],
    answered: Array.from({length:88},(_,index)=>({
      id:"historic-answer-"+index, assistantMessageId:"historic-assistant-"+index,
      userMessageId:"historic-user-"+index, index:1, text:"A conversation question?",
      answer:"Ordinary conversation", exactNumberedMatch:false, projectId:orphan,
    })),
    workProduct: {projectId:orphan, assistantMessageId:"historic-assistant",text:"Old assistant response",
      request:{userMessageId:casualObjective,text:"a little pissy there eh katie"}},
    lastUserIntent:"answer", lastUserMessageId:"historic-user-87",lastAssistantMessageId:"casual-q",
    stage:"awaiting_user_answer",nextAction:"await_user_answers",
    projects: [
      {projectContext:source, objective:{userMessageId:casualObjective,text:"a little pissy there eh katie"},
        pending:[],answered:[]},
      {projectContext:{userMessageId:validProject,text:executiveBrief},
        objective:{userMessageId:validProject,text:executiveBrief},
        sourceChatId:validChat,pending:[],answered:[]},
    ],
  };
}

type DbRow = {actor_id:string;chat_id:string;state:TaskProgressState;updated_at:string};
type Source = {id:string;chat_id:string;actor_id:string;role:string;content:string};
function mockDatabase(rows:DbRow[],sources:Source[]) {
  const writes:DbRow[] = [];
  const progress = rows.map(row=>structuredClone(row));
  const originals = structuredClone(sources);
  const client = {
    from(table:string) {
      const filters:Record<string,unknown>={};
      const query:any = {
        select() {return query;},
        eq(name:string,value:unknown) {filters[name]=value;return query;},
        in(name:string,values:unknown[]) {filters[name]=values;return query;},
        order() {return query;},
        async maybeSingle() {
          const row = table==="chat_task_progress" ? progress.find(p=>p.actor_id===filters.actor_id && p.chat_id===filters.chat_id) : undefined;
          return {data:row?{state:structuredClone(row.state)}:null,error:null};
        },
        then(onfulfilled:any,onrejected?:any) {
          const output = table==="chat_task_progress" ?
            progress.filter(p=>p.actor_id===filters.actor_id).map(p=>structuredClone(p)) :
            originals.filter(m=>m.actor_id===filters.actor_id &&
              (filters.id===undefined ||
                (Array.isArray(filters.id) ? filters.id.includes(m.id) : filters.id===m.id)));
          return Promise.resolve({data:output,error:null}).then(onfulfilled,onrejected);
        },
        async upsert(input:DbRow) {
          assert.equal(table,"chat_task_progress");
          writes.push(structuredClone(input));
          const index=progress.findIndex(p=>p.actor_id===input.actor_id && p.chat_id===input.chat_id);
          if(index<0) progress.push(structuredClone(input)); else progress[index]=structuredClone(input);
          return {data:null,error:null};
        },
      };
      return query;
    },
  };
  return {client,progress,writes,originals};
}
async function withDb<T>(db:ReturnType<typeof mockDatabase>,run:()=>Promise<T>):Promise<T>{
  const holder=globalThis as Record<string,unknown>;
  const previous=holder.__KATIE_SUPABASE_ADMIN_CLIENT__;
  holder.__KATIE_SUPABASE_ADMIN_CLIENT__=db.client;
  try{return await run();}finally{holder.__KATIE_SUPABASE_ADMIN_CLIENT__=previous;}
}
function currentRow(state=legacyState()):DbRow {
  return {actor_id:actor,chat_id:chat,state,updated_at:"2026-11-03T19:31:44.179Z"};
}
function goodSource():Source {
  return {actor_id:actor,chat_id:validChat,id:validProject,role:"user",content:executiveBrief};
}

test("Nov 3 persisted checkpoint rejects orphan source and retains historical evidence",async()=>{
  const db=mockDatabase([currentRow()],[goodSource()]);
  await withDb(db,async()=>{
    const restored=await loadTaskProgress(actor,chat);
    assert.ok(restored);
    assert.equal(restored.projectContext,null);
    assert.equal(restored.objective,null);
    assert.equal(restored.projectAuthority,undefined);
    assert.deepEqual(restored.pending,[]);
    assert.deepEqual(restored.answered,[]);
    assert.equal(restored.workProduct,undefined);
    assert.equal(restored.lastUserIntent,"conversation");
    assert.equal(restored.projects?.length,2,"saved historical snapshots are not erased by read");
    assert.equal(db.writes.length,0,"a read never mutates the production checkpoint");
    assert.equal(db.progress[0].state.projectContext?.userMessageId,orphan);
  });
});

test("actor-owned catalog excludes orphan and preserves source-verified executive assignment",async()=>{
  const db=mockDatabase([currentRow()],[goodSource()]);
  await withDb(db,async()=>{
    const projects=await loadActorTaskProjects(actor);
    assert.deepEqual(projects.map(p=>p.projectContext.userMessageId),[validProject]);
    assert.ok(hasProjectAuthority(projects[0].projectContext,projects[0].projectAuthority));
    const restored=await loadTaskProgress(actor,chat);
    const combined=mergeTaskProjects(restored!,projects);
    assert.deepEqual(taskProjectCatalog(combined).map(p=>p.id),[validProject]);
    const rejected=applyUserToTaskProgress(combined,{messageId:"resume-invalid",
      text:"Return to the older attachment project",projectTransition:{
        action:"resume",projectId:orphan,sourceQuote:"Return to the older attachment project"}});
    assert.equal(rejected.projectContext,null);
    assert.match(rejected.projectClarification??"",/could not be found/i);
    const resumed=applyUserToTaskProgress(combined,{messageId:"resume-valid",
      text:"Return to the financial review",projectTransition:{
        action:"resume",projectId:validProject,sourceQuote:"Return to the financial review"}});
    assert.equal(resumed.projectContext?.userMessageId,validProject);
    assert.ok(hasProjectAuthority(resumed.projectContext,resumed.projectAuthority));
    assert.match(resumed.projectContext?.text??"",/financial reporting system/i);
  });
});

test("ordinary conversation cannot recreate a project after restoration, retry, or save",async()=>{
  const db=mockDatabase([currentRow()],[goodSource()]);
  await withDb(db,async()=>{
    let current=await loadTaskProgress(actor,chat);
    assert.ok(current);
    const history=[
      {id:"replay-u1",role:"user" as const,content:"We adjusted your conversational style. Let's chat."},
      {id:"replay-a1",role:"assistant" as const,content:"What do you want to talk about?"},
      {id:"replay-u2",role:"user" as const,content:"I used to have two alpacas."},
    ];
    current=syncTaskProgress(current,history);
    for(const [i,utterance] of ["The work is never done.","Do you want to pick a topic?","I kept the other alpaca."].entries()){
      current=applyUserToTaskProgress(current,{messageId:"u-"+i,text:utterance});
      current=applyAssistantToTaskProgress(current,{messageId:"a-"+i,text:"And what happened after that?",responsePurpose:"conversation"});
      assert.ok(current.projectContext == null,"ordinary chat has no active parent");
      assert.equal(current.objective,null);
      assert.deepEqual(current.pending,[]);
      assert.equal(current.workProduct,undefined);
    }
    assert.equal(await saveTaskProgress(actor,chat,legacyState()),true,
      "an old retry is normalized rather than reintroducing the invalid binding");
    const afterRetry=await loadTaskProgress(actor,chat);
    assert.equal(afterRetry?.projectContext,null);
    assert.equal(afterRetry?.projects?.length,2);
    assert.equal(db.originals.length,1,"the source ledger was not rewritten");
    assert.equal(await saveTaskProgress(actor,chat,current),true);
    assert.ok((await loadTaskProgress(actor,chat))?.projectContext == null,"saved conversation remains unbound");
    assert.equal(db.writes.length,2);
  });
});

test("real CFO, document and engineering assignments retain their project authority",async()=>{
  for(const task of [
    "Prepare a cash-flow forecast for our CFO review.",
    "Write a professional document evaluating performance.",
    "Implement an isolated fix for the TypeScript routing bug.",
    "New project: create a business website.",
  ]){
    let progress=applyUserToTaskProgress(emptyTaskProgress(),{messageId:"real-work",text:task});
    assert.equal(progress.projectContext?.userMessageId,"real-work",task);
    assert.ok(hasProjectAuthority(progress.projectContext,progress.projectAuthority));
    progress=applyAssistantToTaskProgress(progress,{messageId:"required-question",
      text:"What deadline should this deliverable meet?",responsePurpose:"deliverable"});
    assert.equal(progress.pending.length,1);
    const answer=applyUserToTaskProgress(progress,{messageId:"answer",text:"Friday"});
    assert.equal(answer.lastUserIntent,"answer");
    assert.equal(answer.answered[0]?.answer,"Friday");
    const resume=syncTaskProgress(answer,[]);
    assert.ok(hasProjectAuthority(resume.projectContext,resume.projectAuthority));
  }
  assert.ok(isUserWorkAssignment(executiveBrief),"legacy structured assignment must remain recoverable");
});

test("personal replies cannot create pending project questions or work products",()=>{
  let state=emptyTaskProgress();
  for(const [index,user] of ["You seem different today.","Tell me about the farm.","I have two alpacas.","What should we talk about?"].entries()){
    state=applyUserToTaskProgress(state,{messageId:"person-"+index,text:user});
    state=applyAssistantToTaskProgress(state,{messageId:"chat-"+index,
      text:"That is interesting. What happened next?",responsePurpose:"conversation"});
  }
  assert.ok(state.projectContext == null,"personal replies have no active parent");
  assert.equal(state.objective,null);
  assert.deepEqual(state.pending,[]);
  assert.deepEqual(state.answered,[]);
  assert.equal(state.workProduct,undefined);
  assert.equal(taskProjectCatalog(state).length,0);
});

test("final policy and mocked Anthropic outbound system exclude any synthetic project",async()=>{
  const db=mockDatabase([currentRow()],[goodSource()]);
  await withDb(db,async()=>{
    const restored=(await loadTaskProgress(actor,chat))!;
    const message="It is another place to find projects. Not sure if it is any good yet.";
    const scoped=selectTaskProgressPrompt({
      message,currentUserMessageId:"current-user",history:[{id:"last-user",role:"user"}],
      progress:restored,responsePurpose:"deliverable",managedTask:false,explicitProjectControl:false,
      explicitSavedProjectReference:false,pendingReviewContinuation:false,
    });
    assert.equal(scoped.text,"");
    const pending=Boolean(restored.projectContext && restored.objective &&
      restored.lastUserIntent==="answer" && scoped.text);
    assert.equal(pending,false);
    const policy=decideResponsePolicy({message,responsePurpose:"conversation",intent:"general-text",
      hasPendingDeliverable:pending});
    assert.equal(policy.purpose,"conversation");
    const oldFetch=globalThis.fetch;let outbound="";let audited="";
    globalThis.fetch=(async (_url,options)=>{
      const wire=JSON.parse(String(options?.body)) as {
        system:string|Array<{text:string}>;
      };
      outbound=typeof wire.system==="string"?wire.system:wire.system.map(item=>item.text).join("");
      return new Response(JSON.stringify({content:[{type:"text",text:"Sounds interesting."}],
        stop_reason:"end_turn"}),{status:200,headers:{"content-type":"application/json"}});
    }) as typeof fetch;
    try {
      await runWithOrchestratorAccounting(async()=>new ClaudeProvider("offline-test-key").generate({
        name:"Katie",modelId:"claude-sonnet-5",persona:["Actor prompt unchanged.",scoped.text,policy.generationInstruction].filter(Boolean).join("\n\n"),
        summary:"No extra memory.",history:[],user:message,
        onProviderSystemPrepared:async audit=>{audited=audit.systemMessages.join("\n");},
      }));
      assert.equal(outbound,audited);
      assert.match(outbound,/NEXT RESPONSE: a natural personal conversation/);
      assert.doesNotMatch(outbound,/KATIE_DURABLE_TASK_PROGRESS|CURRENT QUESTION OR DELIVERABLE|ACTIVE PARENT PROJECT/);
      assert.doesNotMatch(outbound,/NEXT RESPONSE: a brief conversational answer/);
    }finally{globalThis.fetch=oldFetch;}
  });
  const route=readFileSync("app/api/chat/route.ts","utf8");
  assert.match(route,/messageId: taskProgressUserMessageId, text: message,/);
  assert.match(route,/hasPendingDeliverable: sourceLinkedPendingWork \|\| Boolean\(pendingReviewClarification\)/);
});


test("cached workflow checkpoint cannot bypass the actor-owned source gate", async () => {
  const db=mockDatabase([currentRow()],[goodSource()]);
  await withDb(db,async()=>{
    const cached=legacyState(); // Historical workflow checkpoint bypassed the DB loader.
    const qualified=(await verifyTaskProgressForUse(actor,chat,cached))!;
    assert.equal(qualified.projectContext,null);
    assert.equal(qualified.objective,null);
    const replay=syncTaskProgress(qualified,[
      {id:"chat-user",role:"user",content:"I had an alpaca named Al."},
      {id:"chat-assistant",role:"assistant",content:"What happened to Al?"},
      {id:"chat-user-two",role:"user",content:"He got stuck under a fence."},
    ]);
    assert.ok(replay.projectContext == null,"cached replay has no active parent");
    assert.equal(replay.objective,null);
    assert.deepEqual(replay.pending,[]);
    assert.deepEqual(replay.answered,[]);
    assert.equal(db.writes.length,0,"verification and replay do not change production");
    const route=readFileSync("app/api/chat/route.ts","utf8");
    assert.match(route,/verifyTaskProgressForUse\(actorId, chatId, cachedTaskProgress\)/);
    assert.match(route,/syncTaskProgress\(verifiedTaskProgress, attachmentHistory\)/);
  });
});
