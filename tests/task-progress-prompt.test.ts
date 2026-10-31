import test from "node:test";
import assert from "node:assert/strict";
import { emptyTaskProgress, formatTaskProgress, type TaskProgressState } from "../lib/chat/task-progress";
import { selectTaskProgressPrompt, type TaskProgressPromptInput } from "../lib/chat/task-progress-prompt";

const parent = "Interim CFO for a PE-backed global manufacturing company. The role requires audit remediation, operational leadership, and experience managing international finance.";
const prior = (): TaskProgressState => ({
  ...emptyTaskProgress(),
  projectContext: { text: parent, userMessageId: "role-brief" },
  objective: { text: "Please share three relevant examples", userMessageId: "old-question" },
  lastUserIntent: "new_task",
});
const input = (overrides: Partial<TaskProgressPromptInput> = {}): TaskProgressPromptInput => ({
  message: "Please share 3 to 5 examples of your relevant experience.",
  currentUserMessageId: "current-user",
  history: [
    { id: "role-brief", role: "user" },
    { id: "old-question", role: "user" },
  ],
  progress: prior(),
  responsePurpose: "deliverable",
  managedTask: false,
  explicitProjectControl: false,
  explicitSavedProjectReference: false,
  pendingReviewContinuation: false,
  projectRelation: "same_project",
  ...overrides,
});

test("ordinary conversation never receives stale project progress even when policy is conservatively deliverable", () => {
  for (const message of [
    "Legs feel awesome.",
    "Tell me about your day.",
    "What do you want to know about me?",
    "Indeed.",
    "[image]",
    "I disagree!",
  ]) {
    const p = prior();
    p.lastUserIntent = "continuation";
    p.pending = [{ id: "q:1", assistantMessageId: "q", index: 1, text: "What would you like to do?" }];
    const result = selectTaskProgressPrompt(input({
      message, progress: p, projectRelation: undefined, responsePurpose: "deliverable",
    }));
    assert.equal(result.text, "", message);
  }
  assert.equal(selectTaskProgressPrompt(input({ message: "Good morning!", responsePurpose: "conversation" })).text, "");
});

test("misclassified same-project uploads and greetings never revive a stale task", () => {
  const stale=prior();
  stale.projectContext={text:"Good. What's up?",userMessageId:"old-greeting"};
  stale.objective={text:"An unrelated earlier request",userMessageId:"old-request"};
  for (const message of ["[image]","[file]","[video]","[files]","Hi Katie!"]) {
    const r=selectTaskProgressPrompt(input({
      message, progress:stale, projectRelation:"same_project",responsePurpose:"deliverable",
    }));
    assert.equal(r.text,"",message);
    assert.equal(r.reason,"ordinary_or_upload_only_turn");
  }
  // A bound review remains eligible when the user is providing requested
  // source evidence; managed tasks retain their explicit work authority.
  assert.match(selectTaskProgressPrompt(input({
    message:"[file]",progress:stale, projectRelation:"same_project",
    pendingReviewContinuation:true,
  })).text,/KATIE_DURABLE_TASK_PROGRESS/);
  assert.match(selectTaskProgressPrompt(input({
    message:"[image]",progress:stale,projectRelation:"same_project",managedTask:true,
  })).text,/KATIE_DURABLE_TASK_PROGRESS/);
});

test("a genuinely new non-project request does not drag in the prior work assignment", () => {
  const p = prior();
  p.projectContext = { text: "Write me a poem about the sea.", userMessageId: "current-user" };
  p.objective = p.projectContext;
  assert.equal(selectTaskProgressPrompt(input({
    message: "Write me a poem about the sea.", progress: p, projectRelation: undefined,
  })).text, "");
  assert.equal(selectTaskProgressPrompt(input({
    message: "Build a different app", progress: prior(), projectRelation: "new_project",
  })).text, "");
  assert.equal(selectTaskProgressPrompt(input({
    message: "Explain the weather", progress: prior(), projectRelation: undefined,
  })).text, "");
});

test("active CFO application and explicit same-project work still receive source-linked task context", () => {
  const selected = selectTaskProgressPrompt(input());
  assert.equal(selected.reason, "confirmed_same_project");
  assert.match(selected.text, /KATIE_DURABLE_TASK_PROGRESS/);
  assert.match(selected.text, /PE-backed global manufacturing/);
  const inferred = selectTaskProgressPrompt(input({projectRelation: undefined}));
  assert.equal(inferred.reason, "scoped_work_request");
  assert.match(inferred.text, /CURRENT QUESTION OR DELIVERABLE/);
});

test("verified source-linked answers preserve unusual tasks without special vocabulary", () => {
  const p = prior();
  p.projectContext = {text:"Help me troubleshoot the intermittent database timeouts.",userMessageId:"debug-brief"};
  p.objective = {text:p.projectContext.text,userMessageId:"debug-brief"};
  p.lastUserIntent = "answer";
  p.answered=[{
    id:"question:1", assistantMessageId:"question", index:1,
    text:"Which database version are you using?",
    userMessageId:"current-user", answer:"PostgreSQL 16.",
    exactNumberedMatch:false, projectId:"debug-brief",
  }];
  const answered=selectTaskProgressPrompt(input({
    message:"PostgreSQL 16.",progress:p,projectRelation:undefined,
    history:[{id:"debug-brief",role:"user"},{id:"question",role:"assistant"}],
  }));
  assert.equal(answered.reason,"source_linked_answer");
  assert.match(answered.text,/KATIE_DURABLE_TASK_PROGRESS/);
  assert.match(answered.text,/troubleshoot the intermittent database timeouts/);
  assert.doesNotMatch(answered.text,/"answer":"PostgreSQL 16/);

  const same=selectTaskProgressPrompt(input({
    message:"Review that timeout trace.",progress:{...p,lastUserIntent:"new_task"},
    projectRelation:"same_project",
  }));
  assert.equal(same.reason,"confirmed_same_project");

  const revision=selectTaskProgressPrompt(input({
    message:"Revise the diagnosis.",progress:{
      ...p,lastUserIntent:"revision",
      workProduct:{projectId:"debug-brief",assistantMessageId:"draft",
        text:"Earlier diagnosis",request:{userMessageId:"debug-brief",text:p.projectContext.text}},
    },projectRelation:undefined,
  }));
  assert.equal(revision.reason,"active_work_revision");
});

test("pending-review continuation, managed development, and explicit project work cannot lose state", () => {
  for (const scenario of [
    { pendingReviewContinuation: true, projectRelation: undefined },
    { managedTask: true, responsePurpose: "conversation" as const, projectRelation: undefined },
    { explicitProjectControl: true, responsePurpose: "conversation" as const, projectRelation: undefined },
    { explicitSavedProjectReference: true, responsePurpose: "conversation" as const, projectRelation: undefined },
  ]) {
    const result = selectTaskProgressPrompt(input(scenario));
    assert.match(result.text, /KATIE_DURABLE_TASK_PROGRESS/);
  }
});

test("a direct answer and a revision keep task context without repeating source conversation", () => {
  const p = prior();
  p.lastUserIntent = "answer";
  p.answered = [{
    id: "asked:1", assistantMessageId: "asked", index: 1,
    text: "Did you lead the audit?", userMessageId: "current-user", answer: "Yes, I led it.",
    exactNumberedMatch: false, projectId: "role-brief",
  }];
  const a = selectTaskProgressPrompt(input({
    message: "Yes, I led it.", progress: p, projectRelation: undefined,
    history: [...input().history, {id:"asked",role:"assistant"}],
  }));
  assert.equal(a.reason, "source_linked_answer");
  assert.match(a.text, /questionAvailableInConversationHistory/);
  assert.match(a.text, /answerAvailableInConversationHistory/);
  assert.ok(!a.text.includes("Did you lead the audit?"));
  assert.ok(!a.text.includes("Yes, I led it."));
  p.lastUserIntent = "revision";
  p.workProduct = {projectId:"role-brief", assistantMessageId:"draft", text:"PRIOR_DRAFT_VERBATIM", request:{userMessageId:"old-question",text:"Please share three relevant examples"}};
  const b = selectTaskProgressPrompt(input({
    message: "Revise the earlier application answer.", progress: p, projectRelation: undefined,
    history: [...input().history, {id:"draft",role:"assistant"}],
  }));
  assert.equal(b.reason, "active_work_revision");
  assert.match(b.text, /workAvailableInConversationHistory/);
  assert.ok(!b.text.includes("PRIOR_DRAFT_VERBATIM"));
});

test("source dedup covers pending Q&A and prior active work without deleting ledger data", () => {
  const p = prior();
  p.answered = [
    {id:"a:1",assistantMessageId:"a",userMessageId:"u",index:1,text:"Exact question already visible?",answer:"Exact answer already visible.",exactNumberedMatch:true},
    {id:"b:1",assistantMessageId:"b",userMessageId:"missing",index:1,text:"Visible question but absent answer?",answer:"Answer outside STM.",exactNumberedMatch:false},
  ];
  p.pending=[{id:"pending:1",assistantMessageId:"pending",index:1,text:"Pending question in STM?"}];
  p.workProduct={projectId:"role-brief",assistantMessageId:"draft",text:"OLD_DRAFT_BODY",request:{userMessageId:"u",text:"Original user wording"}};
  const history=[
    {id:"a",role:"assistant" as const}, {id:"u",role:"user" as const},
    {id:"b",role:"assistant" as const}, {id:"pending",role:"assistant" as const},
    {id:"draft",role:"assistant" as const},
  ];
  const outgoing = formatTaskProgress(p,true,{history});
  assert.ok(!outgoing.includes("Exact question already visible?"));
  assert.ok(!outgoing.includes("Exact answer already visible."));
  assert.ok(!outgoing.includes("Visible question but absent answer?"));
  assert.match(outgoing, /Answer outside STM/);
  assert.ok(!outgoing.includes("Pending question in STM?"));
  assert.ok(!outgoing.includes("OLD_DRAFT_BODY"));
  assert.ok(!outgoing.includes("Original user wording"));
  assert.match(outgoing,/answerAvailableInConversationHistory/);
  assert.match(outgoing,/questionAvailableInConversationHistory/);
  assert.match(outgoing,/workAvailableInConversationHistory/);
  assert.equal(p.answered[0].answer, "Exact answer already visible.");
  assert.equal(p.pending[0].text,"Pending question in STM?");
  assert.equal(p.workProduct.text,"OLD_DRAFT_BODY");
  const original = formatTaskProgress(p);
  assert.match(original,/Exact question already visible/);
  assert.match(original,/Exact answer already visible/);
  assert.match(original,/OLD_DRAFT_BODY/);
});

test("an orphaned historical question or answer is retained if its source is not in provider history", () => {
  const p = prior();
  p.answered=[{id:"q:1",assistantMessageId:"q",userMessageId:"u",index:1,text:"Past question?",answer:"Past answer",exactNumberedMatch:false}];
  const sourceOnly= formatTaskProgress(p,true,{history:[{id:"u",role:"user"}]});
  assert.match(sourceOnly,/Past question/);
  assert.ok(!sourceOnly.includes('"answer":"Past answer"'));
  const questionOnly=formatTaskProgress(p,true,{history:[{id:"q",role:"assistant"}]});
  assert.match(questionOnly,/Past answer/);
  assert.ok(!questionOnly.includes('"question":"Past question?"'));
});

test("current user is not copied into task Q&A when it is supplied as the live model message", () => {
  const p=prior();
  p.answered=[{id:"q:1",assistantMessageId:"q",userMessageId:"current-user",index:1,text:"What is the budget?",answer:"$25 million",exactNumberedMatch:false}];
  const c=formatTaskProgress(p,true,{history:[{id:"q",role:"assistant"}],currentUserMessageId:"current-user"});
  assert.ok(!c.includes('"answer":"$25 million"'));
  assert.match(c,/answerAvailableInConversationHistory/);
});
