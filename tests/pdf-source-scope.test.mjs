import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
const native=createRequire(import.meta.url),root=process.cwd();
function modules(){
 const cache=new Map();
 const load=file=>{
  file=resolve(root,file);if(cache.has(file))return cache.get(file);
  const exports={};cache.set(file,exports);
  const require=name=>name==='@/lib/data/supabase/admin'?{getSupabaseAdminClient:()=>{throw Error('No database or paid provider in this test');}}:name.startsWith('@/')?load(name.slice(2)+'.ts'):name.startsWith('.')?load(resolve(dirname(file),name+'.ts')):native(name);
  vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require,Date,TextEncoder,crypto:webcrypto,console,process:{env:{}}});return exports;
 };return load;
}
const load=modules(),scope=load('lib/chat/pdf-source-selection.ts');
const route=readFileSync('app/api/chat/route.ts','utf8');
const part=(from,to)=>{const a=route.indexOf(from),b=route.indexOf(to,a);assert.ok(a>=0 && b>a,from);return route.slice(a,b);};
const code=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const pdf=(id,name)=>({fileId:id,id,chatId:'chat',fileName:name,mimeType:'application/pdf',preview:`TEXT-${id}`,extractedText:`TEXT-${id}`,pdfInventory:{version:1,pageCount:1,pages:[]},providerRef:{googleFileUri:`offline:${id}`}});
const catalog=files=>files.map(file=>({...file,actorId:'actor',createdAt:'2026-10-15T12:00:00Z'}));
for(const message of ['Read quarterly report.pdf','Read my quarterly report.pdf','Read unknownreport.pdf','Read “quarterly report.pdf”','Read "quarterly report.pdf"'])test(`complete unknown name never selects a suffix: ${message}`,()=>{
 const result=scope.selectPdfEvidenceSource(message,catalog([pdf('short','report.pdf')]),[{attachment_id:'short',source_chat_id:'chat'}],0);
 assert.equal(result.selections.length,0);assert.match(result.clarification,/complete PDF filename/);
});
for(const message of ['Read annual report.pdf','Read “annual report.pdf”','Read "annual report.pdf"','Please inspect the saved annual report.pdf','Where is the revenue breakdown in annual report.pdf?'])test(`long complete source resolves without suffix ambiguity: ${message}`,()=>{
 const result=scope.selectPdfEvidenceSource(message,catalog([pdf('short','report.pdf'),pdf('long','annual report.pdf')]),[],0);
 assert.equal(result.selections.length,1);assert.equal(result.selections[0].attachment.id,'long');
});

async function run(message,fresh){
 const inspected=[],retained=[],sources=new Map();
 const fixture={...scope,newAttachments:fresh,message,pdfSourceTask:message,pdfTaskContext:null,timelineActive:false,timelineSelection:{},mediaMemory:null,savedVideoFollowUp:null,
  catalog:[],attachmentHistory:[],restored:{references:[],unavailable:[],sourceIds:new Set()},timelineContext:'',
  ...load('lib/chat/video-attachment-dedup.ts'),...load('lib/chat/attachment-continuity.ts'),
  fingerprintChatRequest:load('lib/chat/request-idempotency.ts').fingerprintChatRequest,
  selectStoredAttachments:async()=>({method:'none',selections:[]}),
  actorId:'actor',chatId:'chat',overrideProvider:null,overrideModel:null,activeRepoId:null,repoInjectionEnabled:false,
  fileReferences:fresh,legacyImageSources:new Map(),pdfSources:sources,persistedVideoSourceByFileId:new Map(),isVideoAttachment:file=>file.mimeType.startsWith('video/'),
  describeAttachmentEvidence:async file=>({observedSummary:`TEXT-${file.fileId}`,summaryModel:'offline',summaryCoverage:'partial'}),
  persistConversationAttachment:async(_chat,file,_token,{description})=>{retained.push(file.fileId);return {...file,id:'saved-'+file.fileId,...description};},
  inspectSavedPdf:async(_chat,source)=>{inspected.push(source.fileId);return {version:'test',pages:[{physicalPage:1,observations:`EVIDENCE-${source.fileId}`} ]};},
  getChatById:async()=>({actorId:'actor'}),
  name:'Katie',personaForGeneration:'Base',taskProgressContext:'',storedWebsite:{context:'',fresh:false},creativeNarrativeRequest:false,summary:'',historyForProvider:[],messageForGeneration:message,resolvedRequestIntent:'analysis',resolvedRoutingIntentForReroute:null,
  saveProviderSystemAudit:async()=>{},requestId:'same',console,
 };
 const result=await vm.runInNewContext(code(`(async()=>{
 ${part('function buildGenerationParams(', 'async function parseIncomingPayload')}
 ${part('    const freshPdfSelection =', '    const selectedBeforePruning =')}
 ${part('    const requestAttachments =', '    console.log("[Chat API] received attachments"')}
 ${part('    const requestFingerprint =','    const idempotencyClaim =')}
 ${part('            for (const [index, attachment] of newAttachments.entries()) {','            if (timelineActive && temporalIntent) {')}
 ${part('            personaForGeneration += `\\n\\n${selectionContext()}`;', '            await saveMessage(chatId, {')}
 ${part('            for (const pdf of attachments.filter', '            if (shouldRunChunkedWorkflow(')}
 return {params:createParams('offline'),attachments,requestFingerprint,clarification:attachmentDecision.clarification,access:selectionContext()};
})()`),fixture);
 return {...result,inspected,retained};
}
const cases=[
 ['Read report.pdf',['report.pdf','other.pdf'],['0']],
 ['Read only report.pdf',['report.pdf','other.pdf'],['0']],
 ['Read annual report.pdf',['report.pdf','annual report.pdf'],['1']],
 ['Read "annual report.pdf"',['report.pdf','annual report.pdf'],['1']],
 ['Read quarterly report.pdf',['report.pdf','other.pdf'],[]],
 ['Read missing.pdf',['report.pdf','other.pdf'],[]],
 ['Read report.pdf',['report.pdf','report.pdf'],[]],
 ['Read this PDF',['report.pdf','other.pdf'],[]],
 ['Compare report.pdf and other.pdf',['report.pdf','other.pdf'],['0','1']],
 ['Inspect all attached PDFs',['report.pdf','other.pdf'],['0','1']],
 ['Compare report.pdf with all other PDFs',['report.pdf','other.pdf'],['0','1']],
 ['Extract every transaction',['report.pdf'],['0']],
 ['Keep these PDFs for later; tell me a joke',['report.pdf','other.pdf'],[]],
];
for(const [message,names,expected] of cases)test(`actual chat flow inspects only scoped PDFs: ${message} [${names}]`,async()=>{
 const fresh=names.map((name,i)=>pdf(String(i),name));
 const result=await run(message,fresh);
 assert.deepEqual(result.inspected,expected);
 assert.deepEqual(result.retained,names.map((_,i)=>String(i)),'Every uploaded original stays retained');
 assert.equal(JSON.stringify(result.params.attachments.map(file=>file.fileId)),JSON.stringify(expected));
 for(const id of names.map((_,i)=>String(i)).filter(id=>!expected.includes(id))){
  assert.ok(!JSON.stringify(result.params).includes(`TEXT-${id}`));
  assert.ok(!result.access.includes(`TEXT-${id}`));
  assert.ok(!JSON.stringify(result.params).includes(`EVIDENCE-${id}`));
 }
 if(!expected.length && !message.startsWith('Keep'))assert.ok(result.clarification);
});
test('all original fresh source identities remain in the request fingerprint',async()=>{
 const a=await run('Read report.pdf',[pdf('selected','report.pdf'),pdf('unselected','other.pdf')]);
 const retry=await run('Read report.pdf',[pdf('selected','report.pdf'),{...pdf('unselected','other.pdf'),preview:'refreshed cache'}]);
 const changed=await run('Read report.pdf',[pdf('selected','report.pdf'),pdf('different-input','other.pdf')]);
 assert.equal(a.requestFingerprint,retry.requestFingerprint);
 assert.notEqual(a.requestFingerprint,changed.requestFingerprint);
 for(const result of [a,retry,changed])assert.deepEqual(result.inspected,['selected']);
});
test('independent ordinary, saved-draft and clarification assessment keeps only selected PDF evidence',async()=>{
 const result=await run('Read report.pdf',[pdf('selected','report.pdf'),pdf('unselected','other.pdf')]);
 const start=route.indexOf('assessmentParams: {'),end=route.indexOf('\n                leadProvider:',start);
 const shared=load('lib/chat/video-evidence.ts');
 for(const mode of ['ordinary','saved','clarification']){
  const assessment=vm.runInNewContext('({'+route.slice(start,end)+'})',{
   ...shared,createParams:()=>result.params,result:{model:'offline'},hasVideoInput:false,attachments:result.attachments,isVideoAttachment:()=>false,
   savedDraftOriginalTask:mode==='saved'?'Read report.pdf':null,
   pendingReviewClarification:mode==='clarification'?{pending:{sourceTurns:['Read report.pdf'],question:'Which page?'}}:null,
   message:'Page 1',mediaMemory:null,timelineContext:'',reviewSourceParams:{user:'CANDIDATE-DRAFT-LEAK'},
  }).assessmentParams;
  assert.equal(assessment.attachments.length,1);
  assert.equal(assessment.attachments[0].fileId,'selected');
  assert.ok(!JSON.stringify(assessment).includes('TEXT-unselected'));
  assert.ok(!JSON.stringify(assessment).includes('CANDIDATE-DRAFT-LEAK'));
 }
});
test('non-PDF fresh inputs retain ordinary source identity and evidence',async()=>{
 const file={fileId:'text',fileName:'notes.txt',mimeType:'text/plain',preview:'TEXT-text',extractedText:'TEXT-text'};
 const result=await run('Summarize these notes',[file]);
 assert.equal(result.params.attachments[0].fileId,'text');assert.deepEqual(result.inspected,[]);
});
