import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function load(file,imports={}){
 const exports={};
 vm.runInNewContext(compile(readFileSync(file,'utf8')),{exports,require:name=>imports[name]??{},Date});
 return exports;
}
const {resolvePdfNames,selectFreshPdfSources}=load('lib/chat/pdf-source-selection.ts',{'@/lib/uploads/pdf-inventory':load('lib/uploads/pdf-inventory.ts')});
const route=readFileSync('app/api/chat/route.ts','utf8');
function section(start,end){const a=route.indexOf(start),b=route.indexOf(end,a);assert.ok(a>=0&&b>a);return route.slice(a,b);}
const filter=section('    const requestAttachments =','    const images =');
const inspect=section('            for (const pdf of attachments.filter','            const createParams =');
const pdf=(fileId,fileName)=>({fileId,fileName,mimeType:'application/pdf',preview:'',pdfInventory:{version:1,pageCount:1,pages:[]}});
async function run(message,timelineActive=false){
 const fresh=[pdf('named','report.pdf'),pdf('other','other.pdf'),{fileId:'video',fileName:'clip.mp4',mimeType:'video/mp4'}];
 const decision=selectFreshPdfSources(message,fresh,timelineActive),calls=[];
 const actual=await vm.runInNewContext(compile(`(async()=>{${filter}\n${inspect}\nreturn attachments;})()`),{
  requestId:'same-request',freshPdfSelection:decision,newAttachments:fresh,restored:{references:[]},timelineActive,message,
  uniqueAttachmentReferences:files=>files,pdfSources:new Map(fresh.map(file=>[file.fileId,file])),
  actorId:'actor',chatId:'chat',pdfSourceTask:message,resolvePdfNames,...load('lib/uploads/pdf-inventory.ts'),getChatById:async()=>({actorId:'actor'}),
  inspectSavedPdf:async(_chat,source)=>{calls.push(source.fileId);return {state:'inspected',pages:[{physicalPage:1,observations:`PAGE-${source.fileId}`}]};},
 });
 return {decision,calls,actual};
}
const positive=[
 'Compare report.pdf with all PDFs from this upload',
 'Compare report.pdf with all documents in this upload',
 'Compare report.pdf with all files within the current upload',
 'Compare report.pdf with all documents from these attachments',
 'Compare the video with all documents in this upload',
 'Compare the video with all files from this upload',
 'Compare report.pdf with all other PDFs',
 'Compare report.pdf with all PDFs from this upload to find differences',
 'Compare report.pdf with all PDFs from this upload for a summary',
 'Compare report.pdf with all PDFs from this upload that contain revenue',
 'Compare report.pdf with all PDFs from this upload which mention costs',
 'Compare report.pdf with all PDFs from this upload using the figures shown',

 'Compare report.pdf with all PDFs from this upload, please.',
 'Compare report.pdf with all PDFs from this upload and summarize differences',
];
for(const message of positive)test(`current-upload scope reaches every selected PDF: ${message}`,async()=>{
 const {decision,calls,actual}=await run(message);
 assert.equal(decision.clarification,undefined);
 assert.deepEqual([...decision.fileIds],['named','other']);
 assert.deepEqual(calls,['named','other']);
 assert.deepEqual(Array.from(actual.filter(file=>file.mimeType==='application/pdf'),file=>file.pdfEvidence.pages[0].observations),['PAGE-named','PAGE-other']);
});
for(const qualifier of ['in the video','from last week','from another upload','from a previous upload','in the screenshot from this upload','shown in this upload video',"in this upload's video",'in this upload’s video','in this upload video','from this upload batch video',"within the current upload's screenshot",'in these attachments video','in this upload of the video'])test(`external source qualifier does not expand named input: ${qualifier}`,async()=>{
 const {decision,calls}=await run(`Compare report.pdf with all documents ${qualifier}`);
 assert.equal(decision.clarification,undefined);
 assert.deepEqual([...decision.fileIds],['named']);assert.deepEqual(calls,['named']);
});
test('ordinary single-source requests still inspect exactly one PDF',async()=>{
 for(const message of ['Read report.pdf','Read only report.pdf'])assert.deepEqual((await run(message)).calls,['named']);
});
test('conflicting exclusions and unresolved names never buy a broader inspection',async()=>{
 for(const message of ['Compare report.pdf with all PDFs from this upload except other.pdf','Compare missing.pdf with all PDFs from this upload']){
  const result=await run(message);assert.ok(result.decision.clarification);assert.equal(result.calls.length,0);
 }
});
test('filename text cannot impersonate an upload-wide request',()=>{
 const files=[pdf('named','all documents from this upload.pdf'),pdf('other','other.pdf')];
 for(const message of ['Read all documents from this upload.pdf','Read "all documents from this upload.pdf"']){
  assert.deepEqual([...selectFreshPdfSources(message,files).fileIds],['named']);
 }
});
