import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAssistantToTaskProgress, applyUserToTaskProgress, classifyUserTurn, emptyTaskProgress,
  extractAssistantQuestions, formatTaskProgress, rebuildTaskProgress, splitNumberedAnswers,
  syncTaskProgress,
} from "../lib/chat/task-progress";
import { reviewBaseline, acceptanceIds } from "../lib/collaboration/review-contract";
import type { ChatGenerateParams } from "../lib/providers/types";
import { loadTaskProgress, saveTaskProgress } from "../lib/chat/task-progress-store";
import { selectQualityFirstReviewer } from "../lib/collaboration/routing";
import type { LlmProvider } from "../lib/providers/types";
import type { RegistryRoutingModel } from "../lib/models/registry";

const originalTask = "Interim CFO for Global Industrial Client: PE-backed global finance transition, audit, transfer pricing, manufacturing experience. Assess my fit.";
const questions = [
  "1. Are you willing to become a temporary W2 employee of BTG, available 2-3 days a week from 10/26, at $200/hr, and where are you located relative to MN?",
  "2. Have you led or supported any business separation, carve-out or divestiture, or any ERP or systems/data migration, beyond what is on record?",
  "3. Did any of your manufacturing finance roles involve foreign subsidiaries or cross-border intercompany transactions, and have you been CFO or Interim CFO of a manufacturer with international operations?",
].join("\n");
const answers = "1 - w2 is fine, i am available 2-3 days per week and on 10/26, the hourly rate is acceptable. 2-no carve out experience i have lead multiple erp implimentations 3-i have experience with both multinational and manufacturing but not at the same time.";

const history = [
  { role: "user" as const, id: "user-job", content: originalTask },
  { role: "assistant" as const, id: "assistant-1", content: "You are a credible stretch candidate.\nQuestions that could change the strategy:\n" + questions },
];

test("production transcript: exact prior questions link to the user's three numbered answers", () => {
  const original = rebuildTaskProgress(history);
  assert.equal(original.objective?.userMessageId, "user-job");
  assert.equal(original.stage, "awaiting_user_answer");
  assert.equal(original.pending.length, 3);
  const progress = applyUserToTaskProgress(original, { messageId: "user-confirm", text: answers });
  assert.equal(progress.stage, "answers_received");
  assert.equal(progress.pending.length, 0);
  assert.equal(progress.answered.length, 3);
  assert.match(progress.answered[0].answer, /w2 is fine/);
  assert.match(progress.answered[1].answer, /no carve out experience/);
  assert.match(progress.answered[1].answer, /multiple erp implimentations/);
  assert.match(progress.answered[2].answer, /multinational and manufacturing but not at the same time/);
  assert.ok(progress.answered.every(item => item.exactNumberedMatch));
  assert.equal(progress.objective?.text, originalTask);
});

test("reviewer receives linked questions and firsthand user answers, not earlier assistant opinions", () => {
  const progress = applyUserToTaskProgress(rebuildTaskProgress(history), { messageId: "user-confirm", text: answers });
  const params: ChatGenerateParams = {
    name:"Katie", modelId:"lead", persona:"Actor instructions", summary:"CONTAINS UNTRUSTED ASSISTANT CONCLUSIONS",
    user:answers,
    history:[
      { role:"user", content: originalTask },
      { role:"assistant", content: "You are a credible stretch candidate.\n" + questions },
    ],
  };
  const baseline = reviewBaseline(params,progress);
  assert.match(baseline.text,/Questions? to change the strategy|Are you willing to become/);
  assert.match(baseline.text,/no carve out experience/);
  assert.match(baseline.text,/multiple erp implimentations/);
  assert.match(baseline.text,/assistantQuestionSource/);
  assert.match(baseline.text,/userAnswerSource/);
  assert.ok(!baseline.text.includes("You are a credible stretch candidate"));
  assert.ok(!baseline.text.includes("UNTRUSTED ASSISTANT CONCLUSIONS"));
  assert.ok(acceptanceIds({
    objective:"Advance CFO application",qualifications:["Relevant experience"],strongestEvidence:["Verified user answer"],
    criteria:["Advance task"],synthesis:{conclusion:"Move forward",dimensions:[{dimension:"Fit",supportedScope:"Relevant",evidence:["User answer"]}],emphasis:"Do not repeat the initial assessment"},
    taskContract:{deliverable:"A continuation toward the application",requirements:[{id:"r1",requirement:"Continue application",sourceId:"latest-user",status:"active"}],conflicts:[]}
  }).includes("conversation-progression"));
});

test("new explicit request supersedes the previous task rather than creating false Q&A links", () => {
  const previous = rebuildTaskProgress(history);
  const progress = applyUserToTaskProgress(previous, { messageId:"new-request",text:"Build a dashboard for my accounting close." });
  assert.equal(progress.objective?.userMessageId,"new-request");
  assert.equal(progress.pending.length,0);
  assert.equal(progress.stage,"working");
  assert.equal(progress.answered.length,0);
});

test("an evaluation is feedback, not a request to rewrite the previous deliverable", () => {
  const previous = rebuildTaskProgress(history);
  const evaluation = [
    "## My evaluation of Katie's final response",
    "# 8.8/10",
    "The answer is submission-ready, but the manufacturing paragraph reads like a resume.",
    "Katie keeps revising sentences without improving the whole argument.",
    "I think she should learn to distinguish criticism from improvement.",
  ].join("\n");
  assert.equal(classifyUserTurn(evaluation), "feedback");
  const result = applyUserToTaskProgress(previous,{messageId:"evaluation",text:evaluation});
  assert.equal(result.lastUserIntent, "feedback");
  assert.equal(result.objective?.text, originalTask);
  assert.deepEqual(result.pending, previous.pending);
  assert.equal(result.answered.length,0, "feedback must not be misattributed as an answer to prior questions");
  assert.match(formatTaskProgress(result),/do not silently generate another draft/);
  const baseline = reviewBaseline({
    name:"Katie",modelId:"lead",persona:"Application writer",summary:"",
    history:history.map(({role,content})=>({role,content})),
    user:evaluation,
  },result);
  assert.match(baseline.text,/Latest user turn type.*feedback/);
  assert.match(baseline.text,/do not silently generate another draft/);
});

test("explicit feedback-only instruction is not mistaken for embedded rewrite commands",()=>{
  const feedback = [
    "this is feedback only. do not rewrite another version:",
    "For 25 years, including more than 15 as CFO...",
    "Earlier I said: Rewrite my application answer.",
    "This time I am simply evaluating how you handled the critique."
  ].join("\n");
  assert.equal(classifyUserTurn(feedback),"feedback");
  assert.equal(classifyUserTurn("9.4/10. This is Katie's strongest version so far."),"feedback");
  assert.equal(classifyUserTurn("One phrase is awkward: 'I carried production costs'."),"feedback");
});

test("an express revision request remains a revision rather than new or feedback-only task",()=>{
  const previous=applyUserToTaskProgress(rebuildTaskProgress(history),{messageId:"a1",text:answers});
  const command="Please rewrite the application answer using the new feedback without adding irrelevant details.";
  assert.equal(classifyUserTurn(command),"revision");
  assert.equal(classifyUserTurn("My evaluation: the argument is weak.\nPlease revise the application answer accordingly."),"revision");
  const next=applyUserToTaskProgress(previous,{messageId:"revise",text:command});
  assert.equal(next.lastUserIntent,"revision");
  assert.equal(next.objective?.text,originalTask);
  assert.equal(next.answered.length,3, "previous settled answers stay established during revision");
});

test("Please describe creates a new task and never answers pending unrelated questions",()=>{
  const previous=rebuildTaskProgress(history);
  const question="Please describe your experience leading finance for a global industrial/manufacturing business, including audit remediation and transfer pricing. Include company revenue sizes.";
  assert.equal(classifyUserTurn(question),"new_task");
  const result=applyUserToTaskProgress(previous,{messageId:"application-question",text:question});
  assert.equal(result.lastUserIntent,"new_task");
  assert.equal(result.objective?.text,question);
  assert.equal(result.pending.length,0);
  assert.equal(result.answered.length,0);
  assert.equal(result.stage,"working");
});

test("unnumbered reply to many questions never fabricates specific numbered correspondence", () => {
  const previous = rebuildTaskProgress(history);
  const progress = applyUserToTaskProgress(previous,{messageId:"reply",text:"The other issues are settled, but I haven't decided on travel."});
  assert.equal(progress.answered.length,3);
  assert.ok(progress.answered.every(entry => !entry.exactNumberedMatch));
  assert.ok(formatTaskProgress(progress).includes("exactNumberedMatch"));
});

test("task progress survives a provider switch, resume and partial-message replay", () => {
  const earlier = rebuildTaskProgress(history);
  const withAnswer = applyUserToTaskProgress(earlier, { messageId:"user-confirm",text:answers });
  const resumed = syncTaskProgress(earlier,[...history, {role:"user",id:"user-confirm",content:answers}]);
  assert.deepEqual(resumed.answered,withAnswer.answered);
  const next = applyAssistantToTaskProgress(resumed,{messageId:"assistant-next",text:"Understood. The role terms work, your ERP implementations are relevant, and we'll position global and manufacturing experience separately. Ready for the application questions."});
  assert.equal(next.stage,"working");
  assert.equal(next.lastAssistantMessageId,"assistant-next");
  const identical = syncTaskProgress(next,[...history,{role:"user",id:"user-confirm",content:answers},{role:"assistant",id:"assistant-next",content:"Ready for the application questions."}]);
  assert.equal(identical.answered.length,3);
});

test("non-application workflow: user answers report specifications and stage advances", () => {
  const report=[
    {role:"user" as const,id:"r1",content:"Prepare a financial report package."},
    {role:"assistant" as const,id:"r2",content:"1. What reporting date should I use?\n2. Should I include budget versus actual?"}
  ];
  const current=applyUserToTaskProgress(rebuildTaskProgress(report),{messageId:"r3",text:"1. September 30. 2. Yes, include budget versus actual."});
  assert.equal(current.answered.length,2);
  assert.equal(current.pending.length,0);
  assert.match(formatTaskProgress(current),/September 30/);
});

test("numbered answer splitter keeps embedded punctuation and exact user statements", () => {
  assert.equal(splitNumberedAnswers(answers).size,3);
  assert.equal(extractAssistantQuestions("The answer is yes, the revenue is $90M.", "a").length,0);
});

// The database adapter is mocked through the existing Supabase admin injection seam.
test("persistent task progress is actor/chat scoped and can be loaded after a new request", async () => {
  const global = globalThis as Record<string, unknown>;
  const old = global.__KATIE_SUPABASE_ADMIN_CLIENT__;
  const data = new Map<string,Record<string,unknown>>();
  global.__KATIE_SUPABASE_ADMIN_CLIENT__ = {
    from: (table:string) => {
      assert.equal(table,"chat_task_progress");
      const filters:Record<string,string>={};
      const mock:any = {
        select(){return mock;},
        eq(field:string,value:string){filters[field]=value;return mock;},
        async maybeSingle(){
          const row=data.get(filters.actor_id+"|"+filters.chat_id);
          return {data:row?{state:row.state}:null,error:null};
        },
        upsert(row:Record<string,unknown>){
          assert.equal(row.actor_id,"actor-A");
          data.set(row.actor_id+"|"+row.chat_id,row);
          return Promise.resolve({data:null,error:null});
        }
      };
      return mock;
    }
  };
  try {
    const saved=applyUserToTaskProgress(rebuildTaskProgress(history),{messageId:"u2",text:answers});
    assert.equal(await saveTaskProgress("actor-A","chat-A",saved),true);
    assert.deepEqual(await loadTaskProgress("actor-A","chat-A"),saved);
    assert.equal(await loadTaskProgress("actor-B","chat-A"),null);
    assert.equal(await loadTaskProgress("actor-A","chat-B"),null);
  } finally {global.__KATIE_SUPABASE_ADMIN_CLIENT__=old;}
});

test("required-review quality-first selection prefers verified high reasoning over a cheap generic critic", () => {
  const provider=(name:LlmProvider["name"])=>({name} as LlmProvider);
  const lead=provider("anthropic"), strong=provider("openai"), cheap=provider("google");
  const model=(name:string,reasoning:"high"|"low",confidence:number) => ({
    model_id:name, routing_eligibility:"verified", reasoning_tier:reasoning, confidence_score:confidence,
    confidence_tier:"high", supports_text:true,
  } as RegistryRoutingModel);
  const snapshot = new Map<LlmProvider["name"], RegistryRoutingModel[]>([
    ["openai",[model("reasoning-reviewer","high",0.94)]],
    ["google",[model("fast-mini","low",0.99)]],
    ["anthropic",[model("lead","high",1)]],
  ]);
  const input={requester:{provider:"anthropic" as const,modelId:"lead"},providers:[lead,strong,cheap],
    usedParticipants:[{provider:"anthropic" as const,modelId:"lead"}],snapshot};
  const selected=selectQualityFirstReviewer(input);
  assert.equal(selected?.modelId,"reasoning-reviewer");
  assert.equal(selected?.provider.name,"openai");
  const alreadyUsed=selectQualityFirstReviewer({...input,usedParticipants:[
    ...input.usedParticipants,{provider:"openai" as const,modelId:"reasoning-reviewer"}
  ]});
  assert.equal(alreadyUsed,null);
});

