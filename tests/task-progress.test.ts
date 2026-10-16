import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAssistantToTaskProgress, applyUserToTaskProgress, classifyUserTurn, emptyTaskProgress, explicitCurrentQuestion,
  extractAssistantQuestions, formatTaskProgress, rebuildTaskProgress, splitNumberedAnswers,
  isProjectBrief, isTerminologyClarification, syncTaskProgress,
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

test("latest BTG screening prompt is a NEW task rather than an answer to an old question", () => {
  const previous = rebuildTaskProgress(history);
  const prompt = "Please share 3 to 5 examples of your relevant experience.";
  assert.equal(classifyUserTurn(prompt), "new_task");
  assert.equal(classifyUserTurn("List three examples of relevant experience."), "new_task");
  assert.equal(classifyUserTurn("Give me three examples of your work."), "new_task");
  const progress = applyUserToTaskProgress(previous, { messageId: "new-screening-question", text: prompt });
  assert.equal(progress.lastUserIntent, "new_task");
  assert.equal(progress.objective?.text, prompt);
  assert.equal(progress.objective?.userMessageId, "new-screening-question");
  assert.deepEqual(progress.pending, []);
  assert.deepEqual(progress.answered, []);
  const baseline = reviewBaseline({
    name: "Katie", modelId: "lead", persona: "Actor instructions", summary: "",
    history: [{role:"user",content:originalTask}, {role:"user",content:"Previous question: discuss carve-outs."}],
    user:prompt,
  },progress);
  assert.equal(baseline.activeNewTask,true);
  assert.match(baseline.text,/ACTIVE DELIVERABLE \(authoritative question, not an old subtask\)/);
  assert.match(baseline.text,/Earlier question-specific requirements, exclusions and example priorities must NOT constrain/);
  assert.ok(baseline.text.indexOf("ACTIVE DELIVERABLE") < baseline.text.indexOf("ACTIVE CONTRACT SOURCES"));
});


test("BTG regression: correction restores the broad screening question and keeps the parent engagement", () => {
  const parent = "Interim CFO for Global Industrial Client. Private equity backed multinational industrial business. Needs transitional executive oversight, global audit recovery, financial controls, industrial finance, business separation, and systems/data transition.";
  const earlier = [
    {role:"user" as const,id:"job",content:parent},
    {role:"assistant" as const,id:"previous",content:"What additional details do you have?"},
    {role:"user" as const,id:"specific",content:"Please share examples of carve-outs or business separations. Include revenue sizes."},
    {role:"assistant" as const,id:"specialized-answer",content:"Here are only carve-out examples."},
    {role:"user" as const,id:"broad",content:"Please share 3 to 5 examples of your relevant experience."},
    {role:"assistant" as const,id:"bad-answer",content:"Four carve-out examples."},
  ];
  const corrected="no. answer this question: Please share 3 to 5 examples of your relevant experience.";
  assert.equal(explicitCurrentQuestion(corrected),"Please share 3 to 5 examples of your relevant experience.");
  assert.equal(classifyUserTurn(corrected),"new_task");
  const state=applyUserToTaskProgress(rebuildTaskProgress(earlier),{messageId:"corrected",text:corrected});
  assert.equal(state.objective?.text,"Please share 3 to 5 examples of your relevant experience.");
  assert.equal(state.projectContext?.text,parent);
  assert.equal(state.projectContext?.userMessageId,"job");
  assert.equal(state.lastUserIntent,"new_task");
  const baseline=reviewBaseline({
    name:"Katie",modelId:"lead",persona:"Application specialist",summary:"",
    history:earlier.map(turn=>({role:turn.role,content:turn.content})),
    user:corrected,
  },state);
  assert.equal(baseline.activeNewTask,true);
  assert.equal(baseline.activeQuestion,"Please share 3 to 5 examples of your relevant experience.");
  assert.equal(baseline.parentProject,parent);
  assert.equal(baseline.broadProjectQuestion,true);
  assert.match(baseline.text,/BROAD RELEVANCE CHECK/);
  assert.match(baseline.text,/PARENT PROJECT OR ENGAGEMENT/);
  assert.match(baseline.text,/the major needs of the PARENT PROJECT as a whole/);
});

test("new project context supersedes prior project, not every follow-up question",()=>{
  const state = rebuildTaskProgress([
    {id:"p1",role:"user",content:"Prepare a marketing launch with channels, budget, and staffing."},
    {id:"p2",role:"user",content:"Please share three launch examples."},
    {id:"p3",role:"user",content:"New project: Analyze Q3 inventory performance."},
  ]);
  assert.match(state.projectContext?.text ?? "",/Analyze Q3 inventory/);
  assert.equal(state.objective?.text,"New project: Analyze Q3 inventory performance.");
});

const distributionPosting = "FP&A/P&L Advisor for PE-Backed Distribution Company (U.S. only; Hybrid)\nSouthern California 11/02/2026 - 05/02/2027\nOur client, an approximately $100M food distribution company, is seeking an FP&A/P&L Advisor to partner closely with a newly appointed President and support a broader performance improvement effort.";
const distributionQuestion = "**One question:** Do you have any distribution, wholesale, or sponsor-reporting experience that isn’t in your record? If not, I’ll position the application on the adjacent evidence above.";
const mixedDistributionReply = "i do not have specific distribution, wholesale experience, i dont know what sporsor reporting is.";

test("a newly pasted role replaces the old project without requiring an explicit new-project command",()=>{
  const old=applyUserToTaskProgress(rebuildTaskProgress(history),{messageId:"old-facts",text:answers});
  assert.equal(isProjectBrief(distributionPosting),true);
  const current=applyUserToTaskProgress(old,{messageId:"distribution-project",text:distributionPosting});
  assert.equal(current.projectContext?.userMessageId,"distribution-project");
  assert.equal(current.objective?.userMessageId,"distribution-project");
  assert.equal(current.lastUserIntent,"new_task");
  assert.deepEqual(current.answered,[]);
  assert.deepEqual(current.pending,[]);
  const narrower=applyUserToTaskProgress(current,{messageId:"distribution-screening",text:"Please share three relevant examples for the FP&A advisor role.",projectRelation:"same_project"});
  assert.equal(isProjectBrief(narrower.objective!.text),false);
  assert.equal(narrower.projectContext?.userMessageId,"distribution-project");
  assert.equal(narrower.objective?.userMessageId,"distribution-screening");
  const asked=applyAssistantToTaskProgress(narrower,{messageId:"current-question",text:distributionQuestion});
  assert.equal(asked.pending[0]?.projectId,"distribution-project");
  assert.equal(asked.pending[0]?.taskId,"distribution-screening");
});

test("the existing classifier can establish a different project for a brief without a recognizable title",()=>{
  const old=rebuildTaskProgress(history);
  const current=applyUserToTaskProgress(old,{messageId:"new-client",text:"We need a three-month turnaround for a regional distributor.",projectRelation:"new_project"});
  assert.equal(current.projectContext?.userMessageId,"new-client");
  assert.equal(current.objective?.userMessageId,"new-client");
  assert.deepEqual(current.pending,[]);
  const same=applyUserToTaskProgress(old,{messageId:"same-role",text:distributionPosting,projectRelation:"same_project"});
  assert.equal(same.projectContext?.userMessageId,"user-job","same-project classification keeps the established project identity");
});

test("the actual mixed reply records the negative industry fact and keeps the unfamiliar sponsor question open",()=>{
  const original=rebuildTaskProgress([
    {id:"distribution-project",role:"user",content:distributionPosting},
    {id:"sponsor-question",role:"assistant",content:distributionQuestion},
  ]);
  const current=applyUserToTaskProgress(original,{messageId:"mixed-reply",text:mixedDistributionReply});
  assert.equal(current.lastUserIntent,"clarification");
  assert.equal(current.objective?.userMessageId,"distribution-project");
  assert.equal(current.pending[0]?.id,"sponsor-question:1");
  assert.equal(current.stage,"awaiting_user_answer");
  assert.equal(current.answered.length,1);
  assert.equal(current.answered[0].answer,"i do not have specific distribution, wholesale experience");
  assert.equal(current.answered[0].partial,true);
  assert.ok(!current.answered[0].answer.includes("sporsor"),"term uncertainty must not become a negative experience fact");
  assert.match(formatTaskProgress(current),/unfamiliarity with a term does not establish that experience is absent/);

  const explained=applyAssistantToTaskProgress(current,{messageId:"definition",text:"Sponsor reporting means financial reporting to a private equity owner, including board packs and cash-flow reports.",responsePurpose:"conversation"});
  assert.equal(explained.pending[0]?.id,"sponsor-question:1");
  const thanks=applyUserToTaskProgress(explained,{messageId:"thanks",text:"Thanks"});
  assert.equal(thanks.lastUserIntent,"conversation");
  assert.deepEqual(thanks.pending,explained.pending);
  assert.deepEqual(thanks.answered,explained.answered);
  const acknowledged=applyAssistantToTaskProgress(thanks,{messageId:"welcome",text:"You're welcome."});
  const completed=applyUserToTaskProgress(acknowledged,{messageId:"sponsor-fact",text:"Yes, I prepared monthly board packs for private equity owners."});
  assert.equal(completed.lastUserIntent,"answer");
  assert.equal(completed.pending.length,0);
  assert.equal(completed.answered.at(-1)?.assistantMessageId,"sponsor-question");
  assert.equal(completed.answered.at(-1)?.partial,undefined);
});

test("terminology detection distinguishes definitions from substantive diagnostics and unavailable facts",()=>{
  for (const text of [
    "What is sponsor reporting?", "What does accrual mean?", "Could you explain what you mean by reconciliation?",
    "I don't understand what idempotency means.", mixedDistributionReply,
  ]) assert.equal(isTerminologyClarification(text),true,text);
  for (const text of [
    "I don't know.", "I don't have sponsor-reporting experience.", "What is wrong with this code?",
    "What is the best allocation strategy?", "What are the risks in this contract?", "I don't understand why the API fails.",
  ]) assert.equal(isTerminologyClarification(text),false,text);
  const pending=applyAssistantToTaskProgress(applyUserToTaskProgress(emptyTaskProgress(),{messageId:"task",text:"Draft the report."}),{messageId:"question",text:"What revenue figure should I include?"});
  assert.equal(applyUserToTaskProgress(pending,{messageId:"unavailable",text:"I don't know."}).pending.length,0);
  assert.equal(applyUserToTaskProgress(pending,{messageId:"go",text:"Yes, draft it."}).lastUserIntent,"answer","a short instruction can still advance the pending deliverable");
});

test("a numbered reply can answer one question while asking for the meaning of another",()=>{
  const previous=rebuildTaskProgress([
    {id:"task",role:"user",content:"Prepare the application."},
    {id:"questions",role:"assistant",content:"1. Are you available on November 2?\n2. Do you have sponsor-reporting experience?"},
  ]);
  const current=applyUserToTaskProgress(previous,{messageId:"partial",text:"1. Yes, November 2 works. 2. What does sponsor reporting mean?"});
  assert.equal(current.answered.length,1);
  assert.equal(current.answered[0].index,1);
  assert.equal(current.answered[0].exactNumberedMatch,true);
  assert.equal(current.pending.length,1);
  assert.equal(current.pending[0].index,2);
  const explained=applyAssistantToTaskProgress(current,{messageId:"explain",text:"Sponsor reporting is reporting to the private equity owner."});
  assert.equal(explained.pending[0].id,"questions:2","replay without response-purpose metadata must also keep the question");
});

test("partial-history recovery replaces a stale project when a new posting is present",()=>{
  const old=applyUserToTaskProgress(rebuildTaskProgress(history),{messageId:"old-facts",text:answers});
  const recovered=syncTaskProgress(old,[
    {id:"distribution-project",role:"user",content:distributionPosting},
    {id:"new-question",role:"assistant",content:distributionQuestion},
  ]);
  assert.equal(recovered.projectContext?.userMessageId,"distribution-project");
  assert.equal(recovered.answered.length,0);
  assert.equal(recovered.pending[0].projectId,"distribution-project");

  const narrowWindow=syncTaskProgress(old,[
    {id:"screening",role:"user",content:"Please share three relevant examples."},
    {id:"narrow-question",role:"assistant",content:"What revenue figure should I use?"},
  ]);
  assert.equal(narrowWindow.projectContext?.userMessageId,"user-job");
  assert.equal(narrowWindow.objective?.userMessageId,"screening");
  assert.equal(narrowWindow.pending[0].projectId,"user-job");
  assert.equal(narrowWindow.pending[0].taskId,"screening");
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

