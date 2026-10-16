import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
const native=createRequire(import.meta.url),cache=new Map();
const code=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function load(file){
 if(cache.has(file))return cache.get(file);const exports={};cache.set(file,exports);
 vm.runInNewContext(code(readFileSync(file,'utf8')),{exports,Date,console,require:name=>name.startsWith('@/')?load(name.slice(2)+'.ts'):native(name)});return exports;
}
const scope=load('lib/chat/pdf-source-selection.ts');
const route=readFileSync('app/api/chat/route.ts','utf8');
function section(a,b){const start=route.indexOf(a),end=route.indexOf(b,start);assert.ok(start>=0&&end>start);return route.slice(start,end);}
const selection=section('    const freshPdfSelection =','    const selectedBeforePruning =');
const filtering=section('    const requestAttachments =','    const images =');
const pdf=(id,name)=>({id,fileId:id,chatId:'old-chat',fileName:name,mimeType:'application/pdf',preview:'SOURCE-'+id,pdfInventory:{version:'pdf-pages-v1',pageCount:1,pages:[]},createdAt:'2026-10-15T12:00:00Z'});
async function run(message,fresh,saved,genericIds=[]){
 let selectorCalls=0;
 const decision=await vm.runInNewContext(code(`(async()=>{${selection}return {attachmentDecision,freshPdfSelection};})()`),{
  ...scope,message,pdfSourceTask:message,pdfTaskContext:null,newAttachments:fresh,catalog:saved,attachmentHistory:[],timelineActive:false,timelineSelection:{},savedVideoFollowUp:null,mediaMemory:null,
  selectStoredAttachments:async()=>{selectorCalls++;return {method:'none',selections:saved.filter(f=>genericIds.includes(f.id)).map(attachment=>({attachment,mode:'source'}))};},
 });
 const restored={references:decision.attachmentDecision.selections.map(s=>s.attachment)};
 const attachments=vm.runInNewContext(code(`(()=>{${filtering}return attachments;})()`),{
  message,newAttachments:fresh,restored,freshPdfSelection:decision.freshPdfSelection,timelineActive:false,uniqueAttachmentReferences:files=>files,
 });
 return {...decision,attachments,selectorCalls};
}
test('fresh PDF selection preserves an explicitly requested saved chart in real route construction',async()=>{
 const fresh=[pdf('new','new.pdf'),pdf('unused','unused.pdf')],chart={id:'chart',fileId:'chart',chatId:'old-chat',fileName:'saved-chart.png',mimeType:'image/png',preview:'CHART'};
 const result=await run('Compare new.pdf with saved-chart.png',fresh,[chart],['chart']);
 assert.equal(result.selectorCalls,1);assert.deepEqual(Array.from(result.attachments,f=>f.fileId),['new','chart']);
 assert.equal(result.attachmentDecision.clarification,undefined);
});
test('fresh PDF and explicitly named saved PDF both survive fresh-only filtering',async()=>{
 const result=await run('Compare new.pdf with old.pdf',[pdf('new','new.pdf'),pdf('unused','unused.pdf')],[pdf('old','old.pdf')]);
 assert.equal(result.attachmentDecision.clarification,undefined);assert.equal(result.freshPdfSelection.clarification,undefined);
 assert.deepEqual(Array.from(result.attachments,f=>f.fileId),['new','old']);
});
test('multiple explicitly named saved PDFs are a source set, not an ambiguity',async()=>{
 const result=await run('Compare report.pdf and other.pdf',[],[pdf('report','report.pdf'),pdf('other','other.pdf'),pdf('unused','unused.pdf')]);
 assert.equal(result.attachmentDecision.clarification,undefined);
 assert.deepEqual(Array.from(result.attachments,f=>f.fileId),['report','other']);
});
test('duplicate saved identity still clarifies and no generic selector overrides it',async()=>{
 const result=await run('Compare report.pdf and other.pdf',[],[pdf('one','report.pdf'),{...pdf('two','report.pdf'),chatId:'second-chat'},pdf('other','other.pdf')]);
 assert.ok(result.attachmentDecision.clarification);assert.equal(result.attachments.length,0);assert.equal(result.selectorCalls,0);
});
test('fresh missing-source clarification remains a hard stop before saved-source selection',async()=>{
 const result=await run('Read missing.pdf',[pdf('new','new.pdf')],[pdf('old','old.pdf')],['old']);
 assert.ok(result.attachmentDecision.clarification);assert.equal(result.selectorCalls,0);assert.equal(result.attachments.length,0);
});
test('same-named fresh upload wins rather than restoring an older copy',async()=>{
 const result=await run('Read report.pdf',[pdf('new','report.pdf')],[pdf('old','report.pdf')]);
 assert.equal(result.attachmentDecision.clarification,undefined);assert.deepEqual(Array.from(result.attachments,f=>f.fileId),['new']);
});
test('a fresh unrelated PDF does not hide an explicitly requested saved PDF',async()=>{
 const result=await run('Read old.pdf',[pdf('new','new.pdf')],[pdf('old','old.pdf')]);
 assert.equal(result.freshPdfSelection.clarification,undefined);assert.deepEqual(Array.from(result.attachments,f=>f.fileId),['old']);
});
test('non-PDF requests preserve the ordinary stored-source decision',async()=>{
 const chart={id:'chart',fileId:'chart',chatId:'old-chat',fileName:'saved-chart.png',mimeType:'image/png',preview:'CHART'};
 const result=await run('Read saved-chart.png',[],[chart],['chart']);
 assert.equal(result.selectorCalls,1);assert.deepEqual(Array.from(result.attachments,f=>f.fileId),['chart']);
});

test('a same-name saved source remains eligible for an explicitly dated comparison',()=>{
 const fresh=[pdf('new','report.pdf')],saved=[{...pdf('old','report.pdf'),createdAt:'2026-10-15T12:00:00Z'}];
 const message='Compare report.pdf with the saved PDF from yesterday';
 const decision=scope.selectPdfEvidenceSource(message,saved,[],1,new Date('2026-10-16T12:00:00Z'),fresh);
 assert.equal(decision.clarification,undefined);assert.equal(decision.selections[0].attachment.id,'old');
 const ambiguous=scope.selectPdfEvidenceSource('Compare report.pdf with the saved PDF', [...saved,{...saved[0],id:'second',chatId:'second-chat'}],[],1,new Date('2026-10-16T12:00:00Z'),fresh);
 assert.ok(ambiguous.clarification);assert.equal(ambiguous.selections.length,0);
});

test('PDF selection retains an explicitly named saved chart alongside saved and fresh PDFs',async()=>{
 const chart={id:'chart',fileId:'chart',chatId:'old-chat',fileName:'saved-chart.png',mimeType:'image/png',preview:'CHART'};
 for(const fresh of [[],[pdf('new','new.pdf')]]){
  const message=fresh.length?'Compare new.pdf with old.pdf and saved-chart.png':'Compare old.pdf with saved-chart.png';
  const result=await run(message,fresh,[pdf('old','old.pdf'),chart],['chart']);
  assert.equal(result.attachmentDecision.clarification,undefined);
  assert.deepEqual(Array.from(result.attachments,f=>f.fileId),[...(fresh.length?['new']:[]),'old','chart']);
 }
});

test('saved qualifier before the complete same-name filename retains the historical source',async()=>{
 const result=await run('Compare report.pdf with the saved report.pdf',[pdf('new','report.pdf')],[pdf('old','report.pdf'),pdf('unrelated','other.pdf')]);
 assert.equal(result.attachmentDecision.clarification,undefined);
 assert.deepEqual(Array.from(result.attachments,f=>f.fileId),['new','old']);
});

test('relative source date after a complete same-name filename retains the saved version',()=>{
 const message='Compare report.pdf with the PDF report.pdf from yesterday';
 const fresh=[pdf('new','report.pdf')],saved=[{...pdf('old','report.pdf'),createdAt:'2026-10-15T12:00:00Z'}];
 const decision=scope.selectPdfEvidenceSource(message,saved,[],1,new Date('2026-10-16T12:00:00Z'),fresh);
 assert.equal(decision.clarification,undefined);assert.equal(decision.selections[0].attachment.id,'old');
});

test('a singular saved-source request excludes a newly uploaded same-name copy',async()=>{
 const result=await run('Read the saved report.pdf',[pdf('new','report.pdf')],[pdf('old','report.pdf')]);
 assert.equal(result.attachmentDecision.clarification,undefined);
 assert.deepEqual(Array.from(result.attachments,f=>f.fileId),['old']);
 const generic=await run('Read my saved PDF',[pdf('new','new.pdf')],[pdf('old','report.pdf')]);
 assert.deepEqual(Array.from(generic.attachments,f=>f.fileId),['old']);
});
test('a singular dated source excludes the fresh same-name copy while comparisons keep both roles',()=>{
 const fresh=[pdf('new','report.pdf')],saved=[{...pdf('old','report.pdf'),createdAt:'2026-10-15T12:00:00Z'}],message='Read report.pdf uploaded yesterday';
 assert.equal(scope.selectFreshPdfSources(message,fresh,false,saved).fileIds.size,0);
 const selected=scope.selectPdfEvidenceSource(message,saved,[],1,new Date('2026-10-16T12:00:00Z'),fresh);
 assert.equal(selected.selections[0].attachment.id,'old');
});

for(const [message,fresh,saved,expected] of [
 ['Compare a.pdf with saved b.pdf',[pdf('a-new','a.pdf'),pdf('b-new','b.pdf')],[pdf('a-old','a.pdf'),pdf('b-old','b.pdf')],['a-new','b-old']],
 ['Compare saved a.pdf with b.pdf',[pdf('a-new','a.pdf'),pdf('b-new','b.pdf')],[pdf('a-old','a.pdf'),pdf('b-old','b.pdf')],['b-new','a-old']],
 ['Compare saved a.pdf with b.pdf',[pdf('a-new','a.pdf')],[pdf('a-old','a.pdf'),pdf('b-old','b.pdf')],['a-old','b-old']],
]) test(`saved qualifiers bind only their named source: ${message} (${fresh.length} fresh)`,async()=>{
 const result=await run(message,fresh,saved);
 assert.equal(result.attachmentDecision.clarification,undefined);
 assert.deepEqual(Array.from(result.attachments,f=>f.fileId),expected);
});

test('explicit new and saved role qualifiers select exactly their respective versions',async()=>{
 const result=await run('Compare new a.pdf with saved b.pdf',[pdf('a-new','a.pdf'),pdf('b-new','b.pdf')],[pdf('a-old','a.pdf'),pdf('b-old','b.pdf')]);
 assert.equal(result.attachmentDecision.clarification,undefined);
 assert.deepEqual(Array.from(result.attachments,f=>f.fileId),['a-new','b-old']);
});
test('an explicitly shared historical date selects saved versions of both names',()=>{
 const message='Compare both "a.pdf" and "b.pdf" uploaded yesterday';
 const fresh=[pdf('a-new','a.pdf'),pdf('b-new','b.pdf')],saved=[{...pdf('a-old','a.pdf'),createdAt:'2026-10-15T12:00:00Z'},{...pdf('b-old','b.pdf'),createdAt:'2026-10-15T12:00:00Z'}];
 assert.equal(scope.selectFreshPdfSources(message,fresh,false,saved).fileIds.size,0);
 const result=scope.selectPdfEvidenceSource(message,saved,[],2,new Date('2026-10-16T12:00:00Z'),fresh);
 assert.equal(result.clarification,undefined);assert.equal(result.selections.length,2);
});

test('plural historical PDF requests exclude current uploads and select the saved source set',()=>{
 const message='Analyze all saved PDFs from yesterday';
 const fresh=[pdf('new','current.pdf')],saved=[{...pdf('a-old','a.pdf'),createdAt:'2026-10-15T12:00:00Z'},{...pdf('b-old','b.pdf'),createdAt:'2026-10-15T12:00:00Z'}];
 assert.equal(scope.selectFreshPdfSources(message,fresh,false,saved).fileIds.size,0);
 const selected=scope.selectPdfEvidenceSource(message,saved,[],1,new Date('2026-10-16T12:00:00Z'),fresh);
 assert.equal(selected.clarification,undefined);assert.deepEqual(Array.from(selected.selections,item=>item.attachment.id),['a-old','b-old']);
});

test('relative historical PDF sets without a saved adjective also exclude current uploads',()=>{
 const message='Analyze both PDFs from yesterday',fresh=[pdf('new','current.pdf')],saved=[{...pdf('a-old','a.pdf'),createdAt:'2026-10-15T12:00:00Z'},{...pdf('b-old','b.pdf'),createdAt:'2026-10-15T12:00:00Z'}];
 assert.equal(scope.selectFreshPdfSources(message,fresh,false,saved).fileIds.size,0);
 const selected=scope.selectPdfEvidenceSource(message,saved,[],1,new Date('2026-10-16T12:00:00Z'),fresh);
 assert.equal(selected.clarification,undefined);assert.equal(selected.selections.length,2);
});

test('first-person dated source qualifiers exclude current uploads',()=>{
 const fresh=[pdf('new','report.pdf')],saved=[{...pdf('old','report.pdf'),createdAt:'2026-10-15T12:00:00Z'}];
 for(const subject of ['the PDF','report.pdf','"report.pdf"'])for(const relative of ['I','that I','which I'])for(const verb of ['uploaded','saved','attached']){
  const message=`Analyze ${subject} ${relative} ${verb} yesterday`;
  assert.equal(scope.selectFreshPdfSources(message,fresh,false,saved).fileIds.size,0,message);
  const decision=scope.selectPdfEvidenceSource(message,saved,[],1,new Date('2026-10-16T12:00:00Z'),fresh);
  assert.equal(decision.clarification,undefined,message);
  assert.deepEqual(Array.from(decision.selections,x=>x.attachment.id),['old'],message);
 }
});
test('negative actions select only permitted named PDFs across fresh and saved sources',async()=>{
 for(const fresh of [[pdf('a','a.pdf'),pdf('b','b.pdf')],[]])for(const quoted of [true,false])for(const negative of ["don't",'do not','never']){
  const name=x=>quoted?`"${x}.pdf"`:`${x}.pdf`;
  const result=await run(`Read ${name('a')} but ${negative} read ${name('b')}`,fresh,fresh.length?[]:[pdf('a','a.pdf'),pdf('b','b.pdf')]);
  assert.equal(result.attachmentDecision.clarification,undefined);
  assert.equal(result.freshPdfSelection?.clarification,undefined);
  assert.deepEqual(Array.from(result.attachments,x=>x.fileId),['a']);
 }
});
