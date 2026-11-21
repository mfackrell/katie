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
import {runWithStandaloneAccounting, runWithStandaloneActivity, nextStandaloneAttempt} from '../lib/standalone-accounting/context';
import {claimChatRequest} from '../lib/chat/request-idempotency';

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
    id:turn.id,role:turn.role,content:turn.text,chatId:turn.chat_id??f.current.chat_id??'chat-fixture',
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
    ownerSexualBoundaryEnabled:false,cacheablePersona:'Katie actor voice',conversationCacheKey:()=> 'offline-cache',
    actorId:f.current.actor_id??'actor-fixture',chatId:f.current.chat_id??'chat-fixture',
    requestId:'current-request',name:'Katie',personaForGeneration:'Katie actor voice',
    storedWebsite:{fresh:false,context:'',previousWebsiteEvidence:undefined},
    documentProduction:null,DOCUMENT_DRAFT_GUIDANCE:'Document drafting',DOCUMENT_REVIEW_GUIDANCE:'Document review',
    CREATIVE_CONTINUITY_INSTRUCTIONS:'Narrative continuity only',summary:'',
    historyForProvider:history.map(({role,content})=>({role,content})),
    history, // authenticated scoped source messages for the actual objective builder
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
  const f=scenario('C-03');
  // A's conservative classifier does not invent feedback polarity for a
  // direct imperative "Stop rehashing". C still must fulfill that request
  // using scoped conversation, without attributing it to a model.
  const prior=scopedPriorFeedback(f,'negative');
  const unattributed={
    ...prior,
    source:{...prior.source,polarity:'none' as const,correctionExcerpt:null},
    target:{status:'unattributed' as const,reason:'not_feedback' as const},
  };
  const output=prepared(f,undefined,{currentTurnFeedback:unattributed});
  assertObjectiveAndCorrection(output,f);
  assert.match(output.persona,/performance.review|scorecard|interview/i);
  assert.match(output.persona,/avoid|do not|instead|new/i);
  assert.ok(!output.persona.includes('The user criticized the previous response'),
    'A neutral, unattributed record must not invent a negative provider evaluation');
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

test('C-QA3 feedback-plus-topic replacement suppresses stale objective in production generation',()=>{
  const f=scenario('C-01');
  const changed:Case={...f,current:{...f.current,
    text:'That response was terrible. Now explain accrual accounting instead.'}};
  const output=prepared(changed,'best-value',{
    currentTurnFeedback:scopedPriorFeedback(changed,'negative'),
  });
  assert.equal(output.user,changed.current.text);
  assert.ok(!output.persona.includes(f.history.find(t=>t.role==='user')!.text),
    'The explicit new accounting task must not inherit the stale creative objective');
  assert.doesNotMatch(output.persona,/SOURCE-BOUND CURRENT OBJECTIVE CONTINUITY/,
    'Correction plus a replacement task is a topic switch, not a creative-continuation request');
});

test('C-QA5 feedback plus polite or reordered replacement requests must honor the latest task',()=>{
  const f=scenario('C-01');
  const original=f.history.find(t=>t.role==='user')!.text;
  // A's authenticated prior negative feedback can remain valid even when
  // the latest turn explicitly asks for a different substantive objective.
  // These are the exact production source-builder cases the non-author found.
  for (const latest of [
    'That response was terrible. Can you explain accrual accounting instead?',
    'That response was terrible. Please explain accrual accounting instead.',
    'That response was terrible. Instead, explain accrual accounting.',
    'That response was terrible. Could you summarize the balance sheet instead?',
    'That response was terrible. Now explain accrual accounting instead.',
  ]) {
    const changed:Case={...f,current:{...f.current,text:latest}};
    const generated=prepared(changed,'best-value',{
      currentTurnFeedback:scopedPriorFeedback(changed,'negative'),
    });
    assert.equal(generated.user,latest,'The current user request must remain exact');
    assert.ok(!generated.persona.includes(original),
      `Explicit latest request must not promote unrelated creative instructions: ${latest}`);
    assert.doesNotMatch(generated.persona,/SOURCE-BOUND CURRENT OBJECTIVE CONTINUITY/,
      `A fresh task is not an instruction to resume the earlier creative goal: ${latest}`);
  }
  // Regression protection: a real same-task correction is not automatically
  // discarded merely because it contains a feedback phrase or "instead".
  for (const latest of [
    'Katie, that is terrible. You repeated yourself and failed to take initiative.',
    'That response was terrible. Please take initiative instead.',
    'That response was terrible. Instead of another menu, keep leading our creative conversation.',
  ]) {
    const continuing:Case={...f,current:{...f.current,text:latest}};
    const generated=prepared(continuing,'best-value',{
      currentTurnFeedback:scopedPriorFeedback(continuing,'negative'),
    });
    assert.ok(generated.persona.includes(original),
      `Genuine same-task correction must preserve scoped objective: ${latest}`);
    assert.ok(generated.persona.includes(latest),
      'Generation must carry the latest corrective instruction verbatim');
  }
});

test('C-QA6 feedback punctuation and help-me-understand must respect explicit latest task',()=>{
  const f=scenario('C-01');
  const original=f.history.find(t=>t.role==='user')!.text;
  // These sentences are genuine new tasks after feedback, not an invitation
  // to resume the prior creative objective. Exercise the extracted PRODUCTION
  // prepareCandidateRequest for both routing modes with scoped A-v1 evidence.
  for (const latest of [
    'That response was terrible, can you explain accrual accounting instead?',
    'That response was terrible — please explain accrual accounting instead.',
    'That response was terrible. Could you help me understand accrual accounting instead?',
    'That response was terrible, could you help me understand the balance sheet instead?',
  ]) {
    const changed:Case={...f,current:{...f.current,text:latest}};
    for (const mode of ['best-value','best-answer'] as const) {
      const generated=prepared(changed,mode,{
        currentTurnFeedback:scopedPriorFeedback(changed,'negative'),
      });
      assert.equal(generated.user,latest,'Latest user text must remain unchanged');
      assert.ok(!generated.persona.includes(original),
        `Explicit replacement must not revive the old creative goal (${mode}): ${latest}`);
      assert.doesNotMatch(generated.persona,/SOURCE-BOUND CURRENT OBJECTIVE CONTINUITY/,
        `Feedback plus new accounting task is not same-objective continuation: ${latest}`);
    }
  }
  // Genuine same-objective corrections with the same punctuation must retain
  // the original scoped directive. Do not introduce a blanket feedback cutoff.
  for (const latest of [
    'That response was terrible, please take initiative instead.',
    'That response was terrible — instead of another menu, keep leading the conversation.',
    'That response was terrible. Could you be more creative instead?',
  ]) {
    const changed:Case={...f,current:{...f.current,text:latest}};
    const generated=prepared(changed,'best-value',{
      currentTurnFeedback:scopedPriorFeedback(changed,'negative'),
    });
    assert.ok(generated.persona.includes(original),
      `Genuine same-task correction must retain the original authorized goal: ${latest}`);
    assert.ok(generated.persona.includes(latest),
      'Latest corrective instruction must survive into generation guidance');
  }
});


test('C-QA7 standalone latest-topic requests do not revive old objectives in either mode',()=>{
  const f=scenario('C-01');
  const original=f.history.find(t=>t.role==='user')!.text;
  // Non-author findings at the actual A+B+C generation builder boundary.
  // These contain a fresh substantive user task after authenticated criticism,
  // even though A's applicability is null rather than definitively false.
  const replacementRequests=[
    'That response was terrible. What is accrual accounting?',
    'That response was terrible. Can we talk about accrual accounting instead?',
    'That response was terrible. I need help understanding accrual accounting instead.',
    'That response was terrible. Why does depreciation reduce taxable income?',
    'That response was terrible. Could you compare cash and accrual accounting?',
  ];
  for (const latest of replacementRequests) {
    const changed:Case={...f,current:{...f.current,text:latest}};
    for (const mode of ['best-value','best-answer'] as const) {
      const generated=prepared(changed,mode,{
        currentTurnFeedback:scopedPriorFeedback(changed,'negative'),
      });
      assert.equal(generated.user,latest);
      assert.ok(!generated.persona.includes(original),
        `Independent latest task must not acquire stale creative objective (${mode}): ${latest}`);
      assert.doesNotMatch(generated.persona,/SOURCE-BOUND CURRENT OBJECTIVE CONTINUITY/,
        `Fresh topical request must not be recast as old-task feedback: ${latest}`);
    }
  }
  // The distinct task must not be inferred merely from question punctuation
  // or the word "instead": referential corrections remain same-objective.
  for (const latest of [
    'That response was terrible. Please take initiative instead.',
    'That response was terrible. Could you be more creative instead?',
    'That response was terrible. Can you make it better this time?',
    'That response was terrible. Can you explain that more clearly instead?',
  ]) {
    const changed:Case={...f,current:{...f.current,text:latest}};
    for (const mode of ['best-value','best-answer'] as const) {
      const generated=prepared(changed,mode,{
        currentTurnFeedback:scopedPriorFeedback(changed,'negative'),
      });
      assert.ok(generated.persona.includes(original),
        `Same-objective correction must keep trusted continuity (${mode}): ${latest}`);
      assert.ok(generated.persona.includes(latest),
        'Current correction must remain verbatim in generation guidance');
    }
  }
});

test('C-QA4 actual post-routing gate fails closed when optional feedback vanishes',()=>{
  const node=uniqueNode(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='sameScopedPreflightFeedback',
    'sameScopedPreflightFeedback') as ts.FunctionDeclaration;
  const sameScopedPreflightFeedback=evaluate(
    node.getText(routeAst).replace('function sameScopedPreflightFeedback','function'),{});
  const trusted=scopedPriorFeedback(scenario('C-01'),'negative');
  assert.equal(sameScopedPreflightFeedback(trusted,undefined),false,
    'Missing optional routing feedback must never erase a real trusted preflight record');
  assert.equal(sameScopedPreflightFeedback(trusted,null),false);
  assert.equal(sameScopedPreflightFeedback(trusted,{...trusted,source:{...trusted.source,requestId:'foreign'}}),false);
  assert.equal(sameScopedPreflightFeedback(trusted,JSON.parse(JSON.stringify(trusted))),true);
  assert.equal(sameScopedPreflightFeedback(null,undefined),true);
  const gate=uniqueNode(n=>ts.isCallExpression(n)&&ts.isIdentifier(n.expression)&&
    n.expression.text==='sameScopedPreflightFeedback',
    'post-routing feedback gate call') as ts.CallExpression;
  assert.deepEqual(gate.arguments.map(arg=>arg.getText(routeAst)),
    ['preflightTurnFeedback','routingDecision.currentTurnFeedback']);
  const negated=gate.parent;
  assert.ok(ts.isPrefixUnaryExpression(negated)&&negated.operator===ts.SyntaxKind.ExclamationToken);
  const statement=negated.parent;
  assert.ok(ts.isIfStatement(statement),'Mismatch must guard the real routing result');
  assert.match(statement.thenStatement.getText(routeAst),/return await rejectTracked/,
    'Untrusted or absent routing evidence must reject before paid generation');
  const assignment=uniqueNode(n=>ts.isBinaryExpression(n)&&
    n.operatorToken.kind===ts.SyntaxKind.EqualsToken&&
    n.left.getText(routeAst)==='currentTurnFeedback',
    'post-routing currentTurnFeedback assignment') as ts.BinaryExpression;
  assert.equal(assignment.right.getText(routeAst),'preflightTurnFeedback',
    'Matching records must preserve the authenticated preflight version');
  assert.ok(assignment.getStart(routeAst)>=statement.end,
    'The trusted record can only be adopted after the mismatch guard');
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
  const foreignChat:Case={...f,history:f.history.map(turn=>({...turn,chat_id:'foreign-chat'}))};
  const wrongChat=prepared(foreignChat,'best-value',{currentTurnFeedback:sourceLinkedFeedback});
  assert.ok(!wrongChat.persona.includes(f.history[0].text),
    'Source linked to another chat must not be promoted into generation guidance');
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
  // Exercise the real account-scoped deterministic ordinal allocator, not
  // an unused provider-call mock counter. The original request's activity
  // key must not change after a safe resumed invocation.
  const scoped={userId:'c-test-owner',actorId:'c-test-actor',chatId:'c-test-chat',
    requestId:'c-test-durable-request'};
  const allocate=(resumed=false)=>runWithStandaloneAccounting({...scoped,resumed},()=>
    runWithStandaloneActivity('control_plane_routing-rerank',()=>nextStandaloneAttempt()!));
  const first=allocate(),recoveredAttempt=allocate(true);
  assert.equal(first.attemptKey,'control_plane_routing-rerank:0');
  assert.equal(recoveredAttempt.attemptKey,first.attemptKey);
  assert.deepEqual(recoveredAttempt.context.requestId,first.context.requestId);
  assert.deepEqual(recoveredAttempt.context.actorId,first.context.actorId);
  const other=runWithStandaloneAccounting({...scoped,actorId:'foreign-actor'},()=>
    runWithStandaloneActivity('control_plane_routing-rerank',()=>nextStandaloneAttempt()!));
  assert.equal(other.context.actorId,'foreign-actor');
  assert.notEqual(other.context.actorId,first.context.actorId,
    'Attempt IDs are always interpreted inside original authenticated actor scope');
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
  // Execute the PRODUCTION request-claim decision using a sealed, in-memory
  // PostgREST substitute: saved completed requests cannot be re-claimed or
  // assigned to a foreign actor/chat. No transport/provider/production DB.
  const globals=globalThis as unknown as {__KATIE_SUPABASE_ADMIN_CLIENT__?:unknown};
  const previousClient=globals.__KATIE_SUPABASE_ADMIN_CLIENT__;
  const saved={
    request_id:'c14-original-request',actor_id:'actor-c14',chat_id:'chat-c14',
    request_fingerprint:'immutable-hash-c14',status:'completed',
    assistant_message_id:'saved-answer-c14',assistant_model:'gpt-5.6-luna',
    assistant_content:'Saved, complete response',assistant_assets:[],
    error_message:null,created_at:'2026-11-18T00:00:00Z',
    updated_at:'2026-11-18T00:00:03Z',completed_at:'2026-11-18T00:00:03Z',
  };
  let insertAttempts=0,readsFromSaved=0,unexpectedMutations=0;
  globals.__KATIE_SUPABASE_ADMIN_CLIENT__={
    from(table:string) {
      assert.equal(table,'chat_requests');
      return {
        insert(_payload:unknown) {
          insertAttempts++;
          return {then:(resolve:(value:unknown)=>unknown)=>
            Promise.resolve({data:null,error:{message:'unique violation'}}).then(resolve)};
        },
        select(_columns:string) {
          return {eq(field:string,value:string) {
            assert.equal(field,'request_id');assert.equal(value,saved.request_id);
            return {maybeSingle:async()=>{readsFromSaved++;return {data:saved,error:null};}};
          }};
        },
        update(_payload:unknown){unexpectedMutations++;throw Error('Replay must not mutate completed request');},
      };
    },
  };
  try {
    const original={
      requestId:saved.request_id,actorId:saved.actor_id,chatId:saved.chat_id,
      requestFingerprint:saved.request_fingerprint,
    };
    const same=await claimChatRequest(original);
    assert.equal(same.mode,'existing');
    assert.equal(same.mode==='existing'&&same.record.assistantMessageId,saved.assistant_message_id);
    assert.equal(same.mode==='existing'&&same.record.assistantContent,saved.assistant_content);
    const foreign=await claimChatRequest({...original,actorId:'foreign-actor'});
    assert.equal(foreign.mode,'conflict');
    const altered=await claimChatRequest({...original,requestFingerprint:'different-input'});
    assert.equal(altered.mode,'conflict');
    assert.equal(insertAttempts,3);
    assert.equal(readsFromSaved,3);
    assert.equal(unexpectedMutations,0);
  } finally {
    globals.__KATIE_SUPABASE_ADMIN_CLIENT__=previousClient;
  }
  // No provider dispatch/cost accounting is exercised by this browser-only seam;
  // retain B's independent durable receipt and replay acceptance as a separate gate.
});