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
for (const fresh of [[], [pdf('new','new.pdf')]]) test(`saved PDF and chart survive route selection with ${fresh.length} fresh sources`,async()=>{
 const chart={id:'chart',fileId:'chart',chatId:'old-chat',fileName:'chart.png',mimeType:'image/png'};
 const result=await run(`Compare "report.pdf" with "chart.png"${fresh.length?' and "new.pdf"':''}`,fresh,[pdf('report','report.pdf'),chart,pdf('unused','unused.pdf')]);
 assert.equal(result.attachmentDecision.clarification,undefined);
 assert.deepEqual(Array.from(result.attachments,f=>f.fileId),[...fresh.map(f=>f.fileId),'report','chart']);
});
test('ambiguous companion identity clarifies before any source is restored',async()=>{
 const chart={id:'chart',fileName:'chart.png',mimeType:'image/png',chatId:'old-chat'};
 const result=await run('Compare "report.pdf" with "chart.png"',[],[pdf('report','report.pdf'),chart,{...chart,id:'other',chatId:'other-chat'}]);
 assert.ok(result.attachmentDecision.clarification);assert.equal(result.attachments.length,0);
});
test('a companion filename suffix is not an explicit source reference',async()=>{
 const chart={id:'chart',fileId:'chart',chatId:'old-chat',fileName:'chart.png',mimeType:'image/png'};
 const result=await run('Compare "report.pdf" with "other-chart.png"',[],[pdf('report','report.pdf'),chart]);
 assert.deepEqual(Array.from(result.attachments,f=>f.fileId),['report']);
});
test('excluded companion sources cause clarification rather than inspection',async()=>{
 const chart={id:'chart',fileId:'chart',chatId:'old-chat',fileName:'chart.png',mimeType:'image/png'};
 const result=await run('Read "report.pdf" without "chart.png"',[],[pdf('report','report.pdf'),chart]);
 assert.ok(result.attachmentDecision.clarification);assert.equal(result.attachments.length,0);
});
