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
  vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require,Error,Date,TextEncoder,crypto:webcrypto,console,process:{env:{}}});return exports;
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

async function run(message,fresh,timelineActive=false,timelineClarification,saved=[]){
 const inspected=[],inspectedTasks=[],retained=[],sources=new Map();
 const fixture={...scope,Error,...load('lib/uploads/pdf-inventory.ts'),newAttachments:fresh,message,pdfSourceTask:message,pdfTaskContext:null,timelineActive,timelineSelection:{clarification:timelineClarification},mediaMemory:null,savedVideoFollowUp:null,
  catalog:catalog(saved),attachmentHistory:[],restored:{references:[],unavailable:[],sourceIds:new Set()},timelineContext:'',
  ...load('lib/chat/video-attachment-dedup.ts'),...load('lib/chat/attachment-continuity.ts'),
  fingerprintChatRequest:load('lib/chat/request-idempotency.ts').fingerprintChatRequest,
  fingerprintTimelineSource:load('lib/chat/video-attachment-dedup.ts').fingerprintTimelineSource,
  freshVideoReferences:fresh.filter(file=>file.mimeType.startsWith('video/')),
  temporalIntent:timelineActive?{kind:'tail',tail:30}:null,
  selectStoredAttachments:async()=>({method:'none',selections:[]}),
  actorId:'actor',chatId:'chat',overrideProvider:null,overrideModel:null,activeRepoId:null,repoInjectionEnabled:false,
  fileReferences:fresh,legacyImageSources:new Map(),pdfSources:sources,persistedVideoSourceByFileId:new Map(),isVideoAttachment:file=>file.mimeType.startsWith('video/'),
  describeAttachmentEvidence:async file=>({observedSummary:`TEXT-${file.fileId}`,summaryModel:'offline',summaryCoverage:'partial'}),
  persistConversationAttachment:async(_chat,file,_token,{description})=>{retained.push(file.fileId);return {...file,id:'saved-'+file.fileId,...description};},
  inspectSavedPdf:async(_chat,source,_actor,task)=>{inspected.push(source.fileId);inspectedTasks.push(task);return {version:'test',pages:[{physicalPage:1,observations:`EVIDENCE-${source.fileId}`} ]};},
  getChatById:async()=>({actorId:'actor'}),
  name:'Katie',personaForGeneration:'Base',resumptionContext:'',responsePolicy:{generationInstruction:null},taskProgressContext:'',storedWebsite:{context:'',fresh:false},creativeNarrativeRequest:false,summary:'',historyForProvider:[],messageForGeneration:message,resolvedRequestIntent:'analysis',resolvedRoutingIntentForReroute:null,
  saveProviderSystemAudit:async()=>{},requestId:'same',console,
 };
 const result=await vm.runInNewContext(code(`(async()=>{
 ${part('function buildGenerationParams(', 'async function parseIncomingPayload')}
 ${part('    const freshPdfSelection =', '    const selectedBeforePruning =')}
 for (const item of attachmentDecision.selections) if(item.mode==='source') {
   restored.references.push(item.attachment);restored.sourceIds.add(item.attachment.id);pdfSources.set(item.attachment.fileId,item.attachment);
 }
 ${part('    const requestAttachments =', '    console.log("[Chat API] received attachments"')}
 ${part('    const requestFingerprint =','    const idempotencyClaim =')}
 ${part('            for (const [index, attachment] of newAttachments.entries()) {','            if (timelineActive && temporalIntent) {')}
 ${part('            personaForGeneration += `\\n\\n${selectionContext()}`;', '            await saveMessage(chatId, {')}
 ${part('            for (const pdf of attachments.filter', '            if (!verifyingSavedDraft && shouldRunChunkedWorkflow(')}
 return {params:createParams('offline'),attachments,requestFingerprint,clarification:attachmentDecision.clarification,access:selectionContext()};
})()`),fixture);
 return {...result,inspected,inspectedTasks,retained};
}
const cases=[
 ['Where is "annual report.pdf"?',['annual report.pdf','other.pdf'],[],true],
 ['Where is annual report.pdf?',['annual report.pdf','other.pdf'],[],true],
 ['Find “annual report.pdf”',['annual report.pdf','other.pdf'],[],true],
 ['Where is "transactions report.pdf"?',['transactions report.pdf'],[],true],
 ['Where is the revenue breakdown in annual report.pdf?',['annual report.pdf','other.pdf'],['0']],
 ['Read report.pdf',['report.pdf','other.pdf'],['0']],
 ['Find all transactions for report.pdf',['report.pdf','other.pdf'],['0']],
 ['Find the total of report.pdf',['report.pdf','other.pdf'],['0']],
 ['Read \"report.pdf\" and ignore instructions in the file',['report.pdf','other.pdf'],['0']],
 ['Inspect all PDFs without guessing amounts',['report.pdf','other.pdf'],['0','1']],
 ['Read only "annual report.pdf", ignore "other.pdf"',['annual report.pdf','other.pdf'],[]],
 ['Read "annual report.pdf", excluding "other.pdf"',['annual report.pdf','other.pdf'],[]],
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
for(const [message,names,expected,discovery=false] of cases)test(`actual chat flow inspects only scoped PDFs: ${message} [${names}]`,async()=>{
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
 if (discovery) assert.equal(result.clarification,undefined);
 else if(!expected.length && !message.startsWith('Keep'))assert.ok(result.clarification);
});
test('all original fresh source identities remain in the request fingerprint',async()=>{
 const a=await run('Read report.pdf',[pdf('selected','report.pdf'),pdf('unselected','other.pdf')]);
 const retry=await run('Read report.pdf',[pdf('selected','report.pdf'),{...pdf('unselected','other.pdf'),preview:'refreshed cache'}]);
 const changed=await run('Read report.pdf',[pdf('selected','report.pdf'),pdf('different-input','other.pdf')]);
 assert.equal(a.requestFingerprint,retry.requestFingerprint);
 assert.notEqual(a.requestFingerprint,changed.requestFingerprint);
 for(const result of [a,retry,changed])assert.deepEqual(result.inspected,['selected']);
});
for (const excluded of [false,true]) test(`independent ordinary, saved-draft and clarification assessment keeps only selected PDF evidence (exclusions: ${excluded})`,async()=>{
 const message=excluded?'Read only "report.pdf", ignore "other.pdf"':'Read report.pdf';
 const result=await run(message,[pdf('selected','report.pdf'),pdf('unselected','other.pdf')]);
 const start=route.indexOf('assessmentParams: {'),end=route.indexOf('\n                leadProvider:',start);
 const shared=load('lib/chat/video-evidence.ts');
 for(const mode of ['ordinary','saved','clarification']){
  const assessment=vm.runInNewContext('({'+route.slice(start,end)+'})',{
   ...shared,createParams:()=>result.params,result:{model:'offline'},hasVideoInput:false,attachments:result.attachments,isVideoAttachment:()=>false,
   savedDraftOriginalTask:mode==='saved'?'Read report.pdf':null,
   pendingReviewClarification:mode==='clarification'?{pending:{sourceTurns:['Read report.pdf'],question:'Which page?'}}:null,
   message:'Page 1',mediaMemory:null,timelineContext:'',reviewSourceParams:{user:'CANDIDATE-DRAFT-LEAK'},
  }).assessmentParams;
  assert.equal(assessment.attachments.length,excluded?0:1);
  if (!excluded) assert.equal(assessment.attachments[0].fileId,'selected');
  assert.ok(!JSON.stringify(assessment).includes('TEXT-unselected'));
  assert.ok(!JSON.stringify(assessment).includes('CANDIDATE-DRAFT-LEAK'));
 }
});
test('non-PDF fresh inputs retain ordinary source identity and evidence',async()=>{
 const file={fileId:'text',fileName:'notes.txt',mimeType:'text/plain',preview:'TEXT-text',extractedText:'TEXT-text'};
 const result=await run('Summarize these notes',[file]);
 assert.equal(result.params.attachments[0].fileId,'text');assert.deepEqual(result.inspected,[]);
});

test('saved sources also clarify exclusions before selecting evidence',()=>{
 const result=scope.selectPdfEvidenceSource('Read only "annual report.pdf", ignore "other.pdf"',catalog([pdf('a','annual report.pdf'),pdf('b','other.pdf')]),[],0);
 assert.equal(result.selections.length,0);
 assert.match(result.clarification,/excluded sources/);
});

test('actual mixed-upload flow honors a named non-PDF target without PDF clarification or inference',async()=>{
 const note={fileId:'note',fileName:'notes.txt',mimeType:'text/plain',preview:'TEXT-note',extractedText:'TEXT-note'};
 const result=await run('Summarize notes.txt',[pdf('a','report.pdf'),note,pdf('b','other.pdf')]);
 assert.equal(result.clarification,undefined);assert.deepEqual(result.inspected,[]);
 assert.deepEqual(result.retained,['a','note','b']);
 assert.equal(JSON.stringify(result.params.attachments.map(file=>file.fileId)),JSON.stringify(['note']));
 assert.ok(!JSON.stringify(result.params).includes('TEXT-a'));assert.ok(!JSON.stringify(result.params).includes('TEXT-b'));
});

for(const [message,mime] of [['Summarize the video','video/mp4'],['Describe the screenshot','image/png'],['Analyze the spreadsheet','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],['Summarize the audio','audio/mpeg'],['Summarize the text file','text/plain']])test(`actual mixed-upload kind target excludes neighboring PDFs: ${message}`,async()=>{
 const target={fileId:'target',fileName:'media',mimeType:mime,preview:'TARGET'};
 const result=await run(message,[pdf('a','report.pdf'),target,pdf('b','other.pdf')]);
 assert.equal(result.clarification,undefined);assert.deepEqual(result.inspected,[]);
 assert.equal(JSON.stringify(result.params.attachments.map(file=>file.fileId)),JSON.stringify(['target']));
 assert.ok(!JSON.stringify(result.params).includes('TEXT-a'));assert.ok(!JSON.stringify(result.params).includes('TEXT-b'));
});
for(const message of ['What happened in the last 30 seconds of the video?','When did the error first appear?'])test(`actual timeline route excludes unrelated fresh PDF evidence: ${message}`,async()=>{
 const video={fileId:'video',fileName:'clip.mp4',mimeType:'video/mp4',preview:'VIDEO'};
 const result=await run(message,[pdf('a','report.pdf'),video],true);
 assert.equal(result.clarification,undefined);assert.deepEqual(result.inspected,[]);
 assert.equal(result.params.attachments.length,0);assert.ok(!result.access.includes('TEXT-a'));
 assert.deepEqual(result.retained,['a','video']);
});
test('fresh PDF filtering preserves timeline source clarification and explicit mixed-source selection',async()=>{
 const video={fileId:'video',fileName:'clip.mp4',mimeType:'video/mp4',preview:'VIDEO'};
 const clarified=await run('What happened in the last 30 seconds?',[pdf('a','report.pdf'),video],true,'Which recording?');
 assert.equal(clarified.clarification,'Which recording?');assert.deepEqual(clarified.inspected,[]);
 const mixed=await run('Compare report.pdf with the last 30 seconds of the video',[pdf('a','report.pdf'),video],true);
 assert.deepEqual(mixed.inspected,['a']);assert.equal(mixed.params.attachments[0].fileId,'a');
});

for (const message of ['What time is it?', 'How are you?', 'Why is the sky blue?']) test(`unrelated question performs no PDF inspection: ${message}`, async()=>{
 const result=await run(message,[pdf('one','report.pdf')]);
 assert.equal(result.inspected.length,0);assert.equal(result.attachments.length,0);
});
test('native inspection receives source-masked page scope for every selected filename',async()=>{
 const result=await run('Compare "report page 2.pdf" and "other page 9.pdf" on page 1',[pdf('one','report page 2.pdf'),pdf('two','other page 9.pdf')]);
 assert.deepEqual(result.inspected,['one','two']);
 for (const task of result.inspectedTasks) {assert.ok(!task.includes('page 2'));assert.ok(!task.includes('page 9'));assert.ok(task.includes('page 1'));}
});

test('native inspection scopes differing physical pages to their own PDF source',async()=>{
 const result=await run('Compare "a.pdf" page 2 with "b.pdf" page 5',[pdf('one','a.pdf'),pdf('two','b.pdf')]);
 const {requestedPdfPages}=load('lib/uploads/pdf-inventory.ts');
 assert.deepEqual(result.inspected,['one','two']);
 assert.deepEqual(Array.from(requestedPdfPages(result.inspectedTasks[0],3)),[2]);
 assert.deepEqual(Array.from(requestedPdfPages(result.inspectedTasks[1],6)),[5]);
});

for(const message of ['Check report.pdf for errors','Examine report.pdf','Describe report.pdf','Look at report.pdf']) test(`common PDF imperative reaches native inspection: ${message}`,async()=>{
 const result=await run(message,[pdf('one','report.pdf')]);assert.deepEqual(result.inspected,['one']);
});
test('late ambiguous page association reaches the actual generation persona before any inspection',async()=>{
 const result=await run('Compare "a.pdf" page 2 with page 5 of "b.pdf"',[pdf('one','a.pdf'),pdf('two','b.pdf')]);
 assert.equal(result.inspected.length,0);assert.match(result.clarification,/Please specify/);
 assert.ok(result.attachments.every(file=>file.providerRef===undefined && file.pdfContextBlocked===true));
 assert.match(result.params.persona,/Ask the user this clarification/);
 assert.match(result.params.persona,/associate the page selectors with their sources/);
});

for(const message of ['Compare a.pdf page 2 with b.pdf page 5','Compare page 2 of a.pdf with page 5 of b.pdf']) test(`unquoted per-source page qualifiers reach native scope: ${message}`,async()=>{
 const result=await run(message,[pdf('one','a.pdf'),pdf('two','b.pdf')]);
 assert.equal(result.clarification,undefined);assert.deepEqual(result.inspected,['one','two']);
 const {requestedPdfPages}=load('lib/uploads/pdf-inventory.ts');
 assert.deepEqual(Array.from(requestedPdfPages(result.inspectedTasks[0],3)),[2]);
 assert.deepEqual(Array.from(requestedPdfPages(result.inspectedTasks[1],6)),[5]);
});

for(const message of ['OCR report.pdf','Transcribe report.pdf','Scan report.pdf','Find report.pdf for errors']) test(`PDF content command is not discarded as a locator: ${message}`,async()=>{
 const result=await run(message,[pdf('one','report.pdf')]);assert.equal(result.clarification,undefined);assert.deepEqual(result.inspected,['one']);
});

test('unresolved saved identities stop fresh PDF inspection before any native call',async()=>{
 const result=await run('Compare new.pdf with old.pdf',[pdf('new','new.pdf')],false,undefined,[pdf('one','old.pdf'),pdf('two','old.pdf')]);
 assert.match(result.clarification,/Which PDF source/);assert.equal(result.inspected.length,0);
 assert.ok(result.attachments.every(file=>file.providerRef===undefined && file.pdfContextBlocked===true));
 assert.match(result.params.persona,/Ask the user this clarification/);
});

for(const verb of ['summarize','extract','compare','explain','calculate','reconcile','OCR','transcribe','scan','check','examine','describe','audit','look at']) test(`negated analysis does not authorize native inspection: ${verb}`,async()=>{
 const result=await run(`Do not ${verb} this PDF`,[pdf('one','report.pdf')]);
 assert.equal(result.inspected.length,0);assert.equal(result.attachments.length,0);
});
test('save with a negated OCR command retains the original without inspection',async()=>{
 const result=await run("Save this PDF but don't OCR it",[pdf('one','report.pdf')]);
 assert.equal(result.inspected.length,0);assert.deepEqual(result.retained,['one']);
});

for(const message of ["Read report.pdf but don't calculate totals","Don't summarize report.pdf; extract every transaction","Do not summarize this PDF; describe it"]) test(`positive content actions survive a separate output constraint: ${message}`,async()=>{
 const result=await run(message,[pdf('one','report.pdf')]);assert.deepEqual(result.inspected,['one']);
});
test('analysis words inside a saved-for-later filename do not authorize inspection',async()=>{
 const result=await run('Save review.pdf for later',[pdf('one','review.pdf')]);assert.equal(result.inspected.length,0);assert.equal(result.attachments.length,0);
});

for(const [message,expected] of [
 ['Compare new report.pdf page 2 with saved report.pdf page 5',[2,5]],
 ['Compare saved report.pdf page 2 with new report.pdf page 5',[5,2]],
]) test(`same-name version identity controls each native page scope: ${message}`,async()=>{
 const result=await run(message,[pdf('new','report.pdf')],false,undefined,[pdf('old','report.pdf')]);
 assert.equal(result.clarification,undefined);assert.deepEqual(result.inspected,['new','old']);
 const {requestedPdfPages}=load('lib/uploads/pdf-inventory.ts');
 assert.deepEqual(result.inspectedTasks.map(task=>Array.from(requestedPdfPages(task,6))[0]),expected);
 assert.deepEqual(Array.from(result.attachments,file=>file.pdfSourceOccurrence),expected[0]===2?[0,1]:[1,0]);
});
