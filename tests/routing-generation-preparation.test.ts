import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {OpenAiProvider} from '@/lib/providers/openai-provider';
import {quoteSerializedRoutingRequest} from '@/lib/router/control-plane-economics';
import {runWithStandaloneAccounting} from '@/lib/standalone-accounting/context';

// Execute the actual route closures so either call site drifting from the shared
// builder changes the prepared payload under test. No server/provider is called.
const source = ts.createSourceFile('route.ts',readFileSync('app/api/chat/route.ts','utf8'),ts.ScriptTarget.Latest,true);
function find(predicate: (node: ts.Node) => boolean): ts.Node {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => { if (!found && predicate(node)) found=node; if (!found) ts.forEachChild(node,visit); };
  visit(source); assert.ok(found); return found;
}
function expression(name: string) {
  return (find(node => ts.isVariableDeclaration(node) && node.name.getText(source) === name) as ts.VariableDeclaration).initializer!.getText(source);
}
function evaluate(code: string, environment: Record<string, unknown>): any {
  const js = ts.transpileModule(`const closure = ${code};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  return new Function(...Object.keys(environment),`${js}\nreturn closure;`)(...Object.values(environment));
}
const build = find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'buildGenerationParams');
const buildGenerationParams = evaluate(build.getText(source).replace('function buildGenerationParams','function'),{
  workflowTimestamp: () => '2026-11-17T00:00:00Z',
});
for (const visual of [false,true]) test(`routing and generation share preparation for ${visual ? 'visual continuity' : 'secondary web search'}`,async () => {
  const classification = {intent:visual ? 'image-generation' : 'general-text',secondaryIntents:visual ? [] : ['web-search']};
  const context = {creativeTextNarrativeRequest:true, taskProgressContext:'Current deliverable and source',
    resumptionContext:'Continue the approved task', responsePolicy:{generationInstruction:'Produce the requested output'},
    visualContinuity:visual ? {prompt:'Draw Katie using the retained identity anchor',references:[{image:'data:image/png;base64,aGVsbG8='}]} : null};
  let auditWrites = 0;
  const environment: Record<string,unknown> = {
    cacheablePersona:'Stable persona',conversationCacheKey:()=>'cache',actorId:'actor',chatId:'chat',requestId:'request',
    name:'Katie',personaForGeneration:'Actor voice',storedWebsite:{fresh:false,context:'Saved website evidence',previousWebsiteEvidence:undefined},
    documentProduction:{pages:2},DOCUMENT_DRAFT_GUIDANCE:'Draft the document',DOCUMENT_REVIEW_GUIDANCE:'Review the document',
    CREATIVE_CONTINUITY_INSTRUCTIONS:'Keep the established narrative',summary:'Conversation memory',historyForProvider:[],
    message:'Current request',messageForGeneration:'Current request plus attachment context',images:['current-image'],attachments:[],
    resolvedRequestIntent:classification.intent,buildGenerationParams,saveProviderSystemAudit:async()=>{auditWrites++;},
  };
  const prepareCandidateRequest = evaluate(expression('prepareCandidateRequest'),environment);
  const routingProperty = find(node => ts.isPropertyAssignment(node) && node.name.getText(source)==='routingRequestParams') as ts.PropertyAssignment;
  const routing = evaluate(routingProperty.initializer.getText(source),{prepareCandidateRequest,prepareGenerationContext:async()=>context});
  const generation = evaluate(expression('createParams'),{prepareCandidateRequest,generationContext:context,
    resolvedRoutingIntentForReroute:classification,ownerCaptureTrace:undefined});
  const quoted = {...await routing(classification),modelId:'gpt-4o-mini'};
  const generated = generation('gpt-4o-mini');
  assert.equal(quoted.persona,generated.persona);
  assert.match(quoted.persona,/Current deliverable and source/);
  assert.match(quoted.persona,/Produce the requested output/);
  assert.match(quoted.persona,/Draft the document/);
  assert.match(quoted.persona,/Keep the established narrative/);
  assert.deepEqual(quoted.images,generated.images);
  assert.deepEqual(quoted.secondaryIntents,generated.secondaryIntents);
  assert.equal(quoted.user,generated.user);
  if (visual) {assert.equal(quoted.images.length,2);assert.match(quoted.user,/retained identity anchor/);}
  else assert.deepEqual(quoted.secondaryIntents,['web-search']);
  await runWithStandaloneAccounting({userId:'owner',actorId:'actor',chatId:'chat',requestId:'request'},async()=>{
    const provider = new OpenAiProvider('test-only');
    const quote = await quoteSerializedRoutingRequest(provider,quoted);
    const actual = await quoteSerializedRoutingRequest(provider,generated);
    assert.ok(quote?.request_hash);assert.equal(quote.request_hash,actual?.request_hash);
    const omitted = await quoteSerializedRoutingRequest(provider,{...generated,images:[],secondaryIntents:[],persona:'Actor voice',user:'Current request'});
    assert.notEqual(quote.request_hash,omitted?.request_hash);
    assert.equal(auditWrites,0,'quotes cannot persist executed-provider audits');
  });
});
