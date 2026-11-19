/**
 * Agent C (Issue #1120) — offline objective-continuity integration regressions.
 *
 * These tests use production exported helpers and AST-extracted production
 * chat-route request builders. The latter is the same seam used by
 * tests/routing-generation-preparation.test.ts. No provider, database, or
 * remote service is invoked.
 *
 * RED tests are intentional before objective-continuity/Agent A integration:
 * source-linked corrective context does not yet reach the final model persona.
 * A green test from merely replaying the fixture's expected fields is forbidden.
 * Lexical checks are necessary but never independently establish creative quality.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {isCreativeNarrativeTurn,shouldApplyCreativeNarrativeContinuity} from '../lib/chat/creative-continuity';
import {decideResponsePolicy} from '../lib/chat/response-policy';
import {recoverLateRoutingResponse} from '../lib/chat/late-routing-recovery';

interface Turn {
  id: string;
  role: 'user'|'assistant';
  text: string;
  actor_id?: string;
  chat_id?: string;
  model?: string;
  provider?: string;
  request_id?: string;
  status?: string;
}
interface Case {
  id: string;
  title: string;
  category: string;
  history: Turn[];
  current: {id:string;text:string;actor_id?:string;chat_id?:string};
  expect: Record<string,unknown>;
  mode?: 'best-value'|'best-answer';
  modes?: Array<'best-value'|'best-answer'>;
  selected_next?: {provider:string;model:string};
  provider_state?: Record<string,unknown>;
}
const fixturePath='tests/fixtures/routing-objective-continuity-cases.json';
const packet=JSON.parse(readFileSync(fixturePath,'utf8')) as {fixtures:Case[]};
const cases=new Map(packet.fixtures.map(f=>[f.id,f]));
const scenario=(id:string):Case=>{
  const result=cases.get(id);
  assert.ok(result,`Missing scenario ${id}`);
  return result;
};
const routeText=readFileSync('app/api/chat/route.ts','utf8');
const routeAst=ts.createSourceFile('route.ts',routeText,ts.ScriptTarget.Latest,true);
function uniqueNode(predicate:(node:ts.Node)=>boolean,description:string):ts.Node {
  const found:ts.Node[]=[];
  function visit(node:ts.Node):void {
    if(predicate(node)) found.push(node);
    ts.forEachChild(node,visit);
  }
  visit(routeAst);
  assert.equal(found.length,1,`Expected exactly one production ${description}`);
  return found[0];
}
function routeExpression(variable:string):string {
  const node=uniqueNode(n=>ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&n.name.text===variable,variable) as ts.VariableDeclaration;
  assert.ok(node.initializer,`${variable} must have an initializer`);
  return node.initializer.getText(routeAst);
}
function evaluate(expression:string,environment:Record<string,unknown>):any {
  const source=ts.transpileModule(`const captured=${expression};`,{
    compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}
  }).outputText;
  // Local evaluation of frozen, production-repository AST. Not user-supplied code.
  return new Function(...Object.keys(environment),`${source}\nreturn captured;`)(...Object.values(environment));
}
const continuityNode=uniqueNode(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='sourceBoundObjectiveContinuityGuidance','sourceBoundObjectiveContinuityGuidance');
const sourceBoundObjectiveContinuityGuidance=evaluate(
  continuityNode.getText(routeAst).replace('function sourceBoundObjectiveContinuityGuidance','function'),{});
const build=uniqueNode(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='buildGenerationParams','buildGenerationParams');
const buildGenerationParams=evaluate(build.getText(routeAst).replace('function buildGenerationParams','function'),{
  workflowTimestamp:()=> '2026-11-18T23:00:00.000Z'
});

/** Execute actual prepareCandidateRequest from the production chat route. */
function prepared(f:Case, mode=f.mode??'best-answer', overrides:{
  responsePurpose?:'conversation'|'deliverable';
  /** A-owned, v1 source-attributed routing-result field, supplied only in this C-consumer fixture. */
  currentTurnFeedback?:unknown;
}={}) {
  const history=f.history.map(turn=>({
    id:turn.id,role:turn.role,content:turn.text,
    ...(turn.model?{model:turn.model}:{}),
    ...(turn.provider?{provider:turn.provider}:{}),
    ...(turn.request_id?{request_id:turn.request_id}:{}),
    ...(turn.actor_id?{actor_id:turn.actor_id}:{}),
    ...(turn.chat_id?{chat_id:turn.chat_id}:{}),
  }));
  const context={
    creativeTextNarrativeRequest:false,
    responsePolicy:decideResponsePolicy({message:f.current.text,intent:'assistant-reflection',
      responsePurpose:overrides.responsePurpose??'conversation'}),
    taskProgressContext:'',resumptionContext:'',visualContinuity:null,
  };
  const environment:Record<string,unknown>={
    cacheablePersona:'Katie actor voice',conversationCacheKey:()=> 'offline-cache',
    actorId:f.current.actor_id??'actor-fixture',chatId:f.current.chat_id??'chat-fixture',
    requestId:'current-request',name:'Katie',personaForGeneration:'Katie actor voice',
    storedWebsite:{fresh:false,context:'',previousWebsiteEvidence:undefined},
    documentProduction:null,DOCUMENT_DRAFT_GUIDANCE:'Document drafting',DOCUMENT_REVIEW_GUIDANCE:'Document review',
    CREATIVE_CONTINUITY_INSTRUCTIONS:'Narrative continuity only',summary:'',
    historyForProvider:history.map(({role,content})=>({role,content})),
    message:f.current.text,messageForGeneration:f.current.text,images:[],attachments:[],
    resolvedRequestIntent:'assistant-reflection',buildGenerationParams,
    saveProviderSystemAudit:async()=>{throw Error('No provider audit writes permitted in offline test');},
    routingMode:mode==='best-answer'?'best_answer':'best_value',
    currentTurnFeedback:overrides.currentTurnFeedback,
    sourceBoundObjectiveContinuityGuidance,
  };
  const candidate=evaluate(routeExpression('prepareCandidateRequest'),environment);
  const generated=candidate('offline-fixture-model',context,{intent:'assistant-reflection'});
  return generated as {persona:string;user:string;history:Array<{role:string;content:string}>;routingMode?:string};
}

/** Inspect production context supplied to the routing classifier; do not synthesize model evidence. */
function routingContext(f:Case):string {
  const history=f.history.map(turn=>({
    id:turn.id,role:turn.role,content:turn.text,
    model:turn.model,createdAt:undefined,attachments:undefined,
  }));
  return evaluate(routeExpression('controlPlaneConversationContext'),{
    getAccountingScope:()=>undefined,persona:'Actor persona',summary:'',history,
    explicitSavedProjectReference:false,
    priorTaskProgress:{projectContext:null,objective:null,pending:[]},
    images:[],attachments:[],selectionContext:()=>'',sessionContext:{activeRepo:null},
  });
}

function assertObjectiveAndCorrection(generated:ReturnType<typeof prepared>,f:Case):void {
  const original=f.history.find(t=>t.role==='user');
  assert.ok(original,'Objective must originate from a prior user turn');
  assert.match(generated.persona,/objective|continuity|ongoing/i,'Active conversational objective must be explicitly identified in final-generation guidance');
  assert.ok(generated.persona.includes(original.text),
    `Final-generation guidance must carry the user's actual original objective, not only model history (${original.id})`);
  assert.ok(generated.persona.includes(f.current.text),
    `Final-generation guidance must carry the latest corrective user instruction (${f.current.id})`);
  assert.equal(generated.user,f.current.text,'Current user message remains authoritative');
}

/** A-producer contract fixture for exercising C's production consumer only.
 * A's actual receipt/actor verification is independently tested in A #1122.
 */
function scopedPriorFeedback(f:Case,polarity:'positive'|'negative'|'ambiguous') {
  const prior=[...f.history].reverse().find(turn=>turn.role==='assistant');
  assert.ok(prior,'Fixture must contain a prior assistant');
  return {
    version:'current-turn-feedback-v1' as const,
    source:{requestId:'current-request',userMessageId:f.current.id,
      textExcerpt:f.current.text.slice(0,600),polarity,
      dimension:'objective_fidelity' as const,correctionExcerpt:f.current.text.slice(0,600)},
    target:{status:'attributed' as const,assistantMessageId:prior.id,
      priorRequestId:prior.request_id??'fixture-prior-request',
      provider:prior.provider??'openai',model:prior.model??'gpt-5.6-luna',
      priorIntent:'social-emotional',basis:'settled_scoped_saved_reply' as const},
    applicableToOngoingObjective:null,
  };
}

test('C-00 fixture inventory is complete, unique and executable',()=>{
  assert.equal(packet.fixtures.length,14);
  assert.deepEqual([...cases.keys()].sort(),Array.from({length:14},(_,i)=>`C-${String(i+1).padStart(2,'0')}`));
  assert.ok(packet.fixtures.every(f=>f.history.length && f.current.id && f.current.text && f.expect));
});

test('C-01 criticism retains prior user objective and current correction in real generation parameters',()=>{
  const f=scenario('C-01'); const output=prepared(f,undefined,{currentTurnFeedback:scopedPriorFeedback(f,'negative')});
  assertObjectiveAndCorrection(output,f);
  assert.match(output.persona,/do not.*(?:menu|question)|take initiative|proactive/i);
});

test('C-02 positive correction retains the objective without negative-evidence invention',()=>{
  const f=scenario('C-02');const output=prepared(f,undefined,{currentTurnFeedback:scopedPriorFeedback(f,'positive')});
  assertObjectiveAndCorrection(output,f);
  assert.doesNotMatch(output.persona,/negative feedback from current user|current user disliked this answer/i);
});

test('C-03 correction explicitly rejects the stale performance-review premise',()=>{
  const f=scenario('C-03');const output=prepared(f,undefined,{currentTurnFeedback:scopedPriorFeedback(f,'negative')});
  assertObjectiveAndCorrection(output,f);
  assert.match(output.persona,/performance.review|scorecard|interview/i);
  assert.match(output.persona,/avoid|do not|instead|new/i);
  // Independent human QA must additionally judge whether the generated *answer*
  // actually advances something new; lexical no-repeat checks alone cannot.
});

test('C-04 explicit new topic does not acquire creative continuation instructions',()=>{
  const f=scenario('C-04');const output=prepared(f);
  assert.match(output.user,/accrual/);
  assert.doesNotMatch(output.persona,/Katie, take the lead|Be witty, creative, playful/i);
  assert.equal(isCreativeNarrativeTurn(f.current.text,f.history.map(x=>({role:x.role,content:x.text}))),false);
  // Exercise the actual production generation builder with the versioned A-owned
  // route-result contract, not merely an absent continuity flag. A genuine
  // explicit topic switch must win even when older creative turns exist.
  const switchedFeedback={
    version:'current-turn-feedback-v1' as const,
    source:{requestId:'current-request',userMessageId:f.current.id,
      textExcerpt:f.current.text,polarity:'none' as const,
      dimension:'unspecified' as const,correctionExcerpt:null},
    target:{status:'unattributed' as const,reason:'not_feedback' as const},
    applicableToOngoingObjective:false,
  };
  const switched=prepared(f,'best-answer',{currentTurnFeedback:switchedFeedback});
  assert.equal(switched.user,f.current.text,'The explicit latest topic is authoritative');
  assert.ok(!switched.persona.includes(f.history[0].text),
    'A topic-switch provenance signal must not promote the stale creative objective');
  assert.doesNotMatch(switched.persona,/Katie, take the lead|Be witty, creative, playful/i);
});

test('C-05 the latest explicit request to ask questions supersedes old no-questions preference',()=>{
  const f=scenario('C-05');const output=prepared(f);
  assert.match(output.user,/ask me three questions/i);
  assert.doesNotMatch(output.persona,/No menus or unnecessary questions/);
  assert.ok(output.history.some(turn=>turn.content.includes('No menus')),
    'History remains visible but is not promoted to a newer imperative');
});

test('C-06 terminology clarification pauses an active professional deliverable',()=>{
  const f=scenario('C-06');const policy=decideResponsePolicy({
    message:f.current.text,hasPendingDeliverable:true,
    intent:'general-text',responsePurpose:'deliverable'
  });
  assert.equal(policy.purpose,'conversation');
  assert.equal(policy.requiresSubstantiveProcessing,false);
  assert.match(policy.generationInstruction??'',/Keep the active substantive task pending/);
});

test('C-07 open-ended creative personal chat does not force a fictional-scene route',()=>{
  const f=scenario('C-07');
  assert.equal(isCreativeNarrativeTurn(f.current.text,f.history.map(x=>({role:x.role,content:x.text}))),false);
  const policy=decideResponsePolicy({message:f.current.text,intent:'assistant-reflection',responsePurpose:'conversation'});
  assert.equal(policy.purpose,'conversation');
  assert.equal(policy.generationInstruction,null);
});

test('C-08 v1 feedback provenance must reach generation as prior settled source, not next model',()=>{
  const f=scenario('C-08');
  const prior=f.history.find(x=>x.role==='assistant')!;
  // Synthetic A-result input tests only C's actual production generation consumer.
  // It is NOT evidence that Agent A's unimplemented producer can attribute feedback.
  const sourceLinkedFeedback={
    version:'current-turn-feedback-v1' as const,
    source:{
      requestId:'current-request',userMessageId:f.current.id,
      textExcerpt:f.current.text,polarity:'negative' as const,
      dimension:'objective_fidelity' as const,correctionExcerpt:f.current.text,
    },
    target:{
      status:'attributed' as const,assistantMessageId:prior.id,
      priorRequestId:prior.request_id!,provider:prior.provider!,model:prior.model!,
      priorIntent:'social-emotional',basis:'settled_scoped_saved_reply' as const,
    },
    applicableToOngoingObjective:null,
  };
  assert.equal(sourceLinkedFeedback.target.model,f.expect.feedback_target_model);
  assert.notEqual(sourceLinkedFeedback.target.model,f.selected_next!.model,
    'Fixture must distinguish criticized prior model from next selected responder');
  const result=prepared(f,'best-value',{currentTurnFeedback:sourceLinkedFeedback});
  const guidance=result.persona;
  // Inspect the actual production prepareCandidateRequest execution; never
  // count fixture-shape validation as successful source-to-generator integration.
  assert.ok(guidance.includes(f.current.text),'Current exact correction must reach generation guidance');
  assert.ok(guidance.includes(f.history.find(x=>x.role==='user')!.text),
    'Source-linked prior user objective must reach generation guidance');
  assert.match(guidance,/previous|prior|attribut|feedback|correct/i,
    'Generation must receive explicit correction context separate from generic conversation history');
  // The same current correction may not promote another prior assistant
  // or a forged source request into generation instructions.
  const wrongTarget=prepared(f,'best-value',{currentTurnFeedback:{
    ...sourceLinkedFeedback,target:{...sourceLinkedFeedback.target,assistantMessageId:'foreign-assistant'},
  }});
  assert.ok(!wrongTarget.persona.includes(f.history[0].text),
    'Misattributed previous assistant must fail closed');
  const wrongRequest=prepared(f,'best-value',{currentTurnFeedback:{
    ...sourceLinkedFeedback,source:{...sourceLinkedFeedback.source,requestId:'foreign-request'},
  }});
  assert.ok(!wrongRequest.persona.includes(f.history[0].text),
    'Foreign request provenance must fail closed');
  assert.ok(!guidance.includes(f.selected_next!.model),
    'Do not claim the newly selected responder authored the criticized answer');
});

test('C-09 feedback without a completed prior assistant has no invented attribution',()=>{
  const f=scenario('C-09');const ctx=routingContext(f);
  assert.doesNotMatch(ctx,/feedback_target|attributed_model|gpt-5\.6-luna/i);
  assert.ok(!f.history.some(x=>x.role==='assistant'));
});

test('C-10 unrelated actors and chats cannot enter actual scoped context assembly',()=>{
  const f=scenario('C-10');
  assert.ok(f.history.every(x=>x.actor_id!==f.current.actor_id&&x.chat_id!==f.current.chat_id));
  // Verify the executable production AST, not a regex that a dead comment
  // could satisfy: scoped loader arguments must originate from the authenticated
  // request variables and be passed to the context-cache callback.
  const scopedLoad=uniqueNode(n=>ts.isCallExpression(n) && ts.isIdentifier(n.expression) &&
    n.expression.text==='assembleContext','scoped assembleContext call') as ts.CallExpression;
  assert.deepEqual(scopedLoad.arguments.map(arg=>arg.getText(routeAst)),['actorId','chatId']);
  const loaderCallback=scopedLoad.parent;
  assert.ok(ts.isArrowFunction(loaderCallback) && loaderCallback.body===scopedLoad,
    'Scoped context loader must execute as the cached workflow callback');
  const cachedLoad=loaderCallback.parent;
  assert.ok(ts.isCallExpression(cachedLoad) && ts.isIdentifier(cachedLoad.expression) &&
    cachedLoad.expression.text==='cachedWorkflowValue',
    'Scoped loader must use the existing durable assembled-context cache');
  assert.equal(cachedLoad.arguments[0].getText(routeAst),'\"assembled-context\"');
  // Do not inject the unrelated history: it was never an admitted actor/chat source.
  const scoped={...f,history:f.history.filter(x=>x.actor_id===f.current.actor_id&&x.chat_id===f.current.chat_id)};
  assert.doesNotMatch(routingContext(scoped),/Be witty, creative, playful|journal, an interview/);
});

test('C-11 pending uncertain request resumes original workflow once with objective and correction',async()=>{
  const f=scenario('C-11');assert.equal(f.provider_state?.status,'uncertain');
  let checks=0,resumptions=0;
  const savedObjective=f.history.find(x=>x.role==='user')!.text;
  const savedCorrection=f.current.text;
  const recovered=await recoverLateRoutingResponse({
    readStatus:async()=>{checks++;return {status:'processing',workflowStatus:'paused',routingRecoveryReady:true};},
    resumeOriginal:async()=>{resumptions++;return Response.json({objective:savedObjective,correction:savedCorrection});},
    wait:async()=>{throw Error('No wait needed');},cancelled:()=>false,maxChecks:3,
  });
  const body=await recovered!.json() as {objective:string;correction:string};
  assert.equal(body.objective,savedObjective);assert.equal(body.correction,savedCorrection);
  assert.equal(checks,1);assert.equal(resumptions,1);
  // This is the browser resume seam; B-owned provider receipt/charge tests must
  // independently establish that resuming does not retransmit an uncertain call.
});

test('C-12 Best Answer and Best Value carry identical objective/correction source, not selection policy',()=>{
  const f=scenario('C-12');const feedback=scopedPriorFeedback(f,'negative');const answer=prepared(f,'best-answer',{currentTurnFeedback:feedback});const value=prepared(f,'best-value',{currentTurnFeedback:feedback});
  assertObjectiveAndCorrection(answer,f);assertObjectiveAndCorrection(value,f);
  assert.equal(answer.persona,value.persona);
  assert.equal(answer.user,value.user);
  assert.equal(answer.routingMode,'best_answer');assert.equal(value.routingMode,'best_value');
});

test('C-13 explicit image-generation intent suppresses narrative continuation',()=>{
  const f=scenario('C-13');const history=f.history.map(x=>({role:x.role,content:x.text}));
  assert.equal(shouldApplyCreativeNarrativeContinuity(isCreativeNarrativeTurn(f.current.text,history),'image-generation'),false);
  assert.match(f.current.text,/Generate a picture/);
});

test('C-14 saved completed request never triggers browser auto-resume',async()=>{
  const f=scenario('C-14');assert.equal(f.provider_state?.existing_final_message_saved,true);
  let resumptions=0,reads=0;
  const result=await recoverLateRoutingResponse({
    readStatus:async()=>{reads++;return {status:'completed',workflowStatus:'completed',routingRecoveryReady:false};},
    resumeOriginal:async()=>{resumptions++;throw Error('Must not send new request after saved completion');},
    wait:async()=>{throw Error('Completed request must not be polled repeatedly');},cancelled:()=>false,maxChecks:3,
  });
  assert.equal(result,null);assert.equal(reads,1);assert.equal(resumptions,0);
  // No provider dispatch/cost accounting is exercised by this browser-only seam;
  // retain B's independent durable receipt and replay acceptance as a separate gate.
});