import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve,dirname} from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
const native=createRequire(import.meta.url),cache=new Map();
function load(file){
 file=resolve(file);if(cache.has(file))return cache.get(file);
 const exports={};cache.set(file,exports);
 const require=name=>name.startsWith('@/')?load(name.slice(2)+'.ts'):name.startsWith('.')?load(resolve(dirname(file),name+'.ts')):native(name);
 vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require,Date,console});return exports;
}
const {formatAttachmentContext}=load('lib/providers/attachment-context.ts');
function fixture(count=3,contextPages){
 const page=n=>({physicalPage:n,text:`CANONICAL_PAGE_${n}`,textCoverage:'present',visualCoverage:'not-inspected',runs:[{text:`LAYOUT_PAGE_${n}`,x:1,y:1}],lines:[],layoutTruncated:false});
 const pages=Array.from({length:count},(_,i)=>page(i+1));
 const file={fileId:'source',fileName:'report.pdf',mimeType:'application/pdf',sourceFingerprint:'a'.repeat(64),preview:'GLOBAL_PREVIEW_PAGE_1 GLOBAL_PREVIEW_PAGE_3',extractedText:'GLOBAL_FLAT_PAGE_1 GLOBAL_FLAT_PAGE_3',
 pdfInventory:{version:'pdf-pages-v1',pageCount:count,units:'pdf2json page units',pages},
 extractedChunks:pages.map((p,i)=>({index:i,total:count,physicalPage:p.physicalPage,text:`CHUNK_PAGE_${p.physicalPage}`,start:0,end:12})),totalChunks:count};
 if(contextPages!==undefined)file.pdfEvidence={version:'pdf-visual-v1',extractionVersion:'pdf-pages-v1',provider:'google',model:'offline',fingerprint:file.sourceFingerprint,contextPages,state:'partial',notice:'Model observations are unverified.',rawReports:['GLOBAL_REPORT_PAGE_1'],pages:pages.map(p=>({physicalPage:p.physicalPage,status:'readable',observations:`VISUAL_PAGE_${p.physicalPage}`,rows:[]}))};
 return file;
}
const rendered=(file,message,options={})=>formatAttachmentContext([file],{userMessage:message,...options});
function onlyPages(text,chosen,count){
 for(let n=1;n<=count;n++)if(!chosen.includes(n))assert.doesNotMatch(text,new RegExp(`(?:CHUNK|VISUAL|LAYOUT|CANONICAL)_PAGE_${n}(?![0-9])`));
 assert.doesNotMatch(text,/GLOBAL_(?:PREVIEW|FLAT|REPORT)_PAGE/);
}
for(const count of [3,10])test(`page two filters ${count} page chunks BEFORE relevance scoring`,()=>{
 const file=fixture(count,[2]);file.extractedChunks[0].text+=' repeated keyword repeated keyword';
 const out=rendered(file,'Read page 2 and find repeated keyword');
 assert.match(out,/CHUNK_PAGE_2/);assert.match(out,/VISUAL_PAGE_2/);onlyPages(out,[2],count);
 assert.doesNotMatch(out,/All extracted text chunks were injected/);
});
test('validated multi-page comparisons include only their own chunks and layout',()=>{
 const out=rendered(fixture(6,[2,4]),'Compare pages 2 and 4');
 assert.match(out,/CHUNK_PAGE_2/);assert.match(out,/CHUNK_PAGE_4/);onlyPages(out,[2,4],6);
});
test('continuation context agrees across extracted chunks, layout and visual findings',()=>{
 const out=rendered(fixture(9,[5,6,7,8]),'Continue');
 for(const page of [5,6,7,8])assert.match(out,new RegExp(`CHUNK_PAGE_${page}`));
 onlyPages(out,[5,6,7,8],9);
});
test('a failed page selector cannot expose prior cached pages or global text',()=>{
 const out=rendered(fixture(3,[1,2]),'Read page -1');onlyPages(out,[],3);
});
test('cached context cannot widen an explicit page request or introduce an invalid page',()=>{
 const out=rendered(fixture(3,[1,2,3,0,999,1.5]),'Read page 2');
 assert.match(out,/CHUNK_PAGE_2/);onlyPages(out,[2],3);
});
test('untagged chunks and flat-body fallbacks cannot bypass inventory page scope',()=>{
 for(const kind of ['none','untagged','foreign']){
  const file=fixture(3,[2]);
  file.extractedChunks=kind==='none'?[]:kind==='untagged'?[{index:0,text:'UNTAGGED_ALL_PAGES'}]:[{index:0,physicalPage:3,text:'FOREIGN_PAGE_BODY'}];
  const out=rendered(file,'Read page 2');
  assert.match(out,/LAYOUT_PAGE_2/);onlyPages(out,[2],3);assert.doesNotMatch(out,/UNTAGGED_ALL_PAGES|FOREIGN_PAGE_BODY/);
 }
});
test('ordinary inventoried PDF text without native findings still obeys the requested page',()=>{
 const out=rendered(fixture(3),'Read page 2');assert.match(out,/CHUNK_PAGE_2/);onlyPages(out,[2],3);
});
test('page scope preserves literal duplicate contents and non-PDF behavior',()=>{
 const file=fixture(3,[2]);file.extractedChunks.push({...file.extractedChunks[1],index:3});
 const out=rendered(file,'Read page 2');assert.equal((out.match(/CHUNK_PAGE_2/g)||[]).length,2);
 const text={fileId:'plain',fileName:'notes.txt',mimeType:'text/plain',preview:'preview',extractedText:'ORDINARY_TEXT_BODY'};
 assert.match(rendered(text,'Read page 2'),/ORDINARY_TEXT_BODY/);
});
test('actual independent-assessment construction retains task context and the identical page-limited evidence',()=>{
 const route=readFileSync('app/api/chat/route.ts','utf8');
 const start=route.indexOf('assessmentParams: {'),end=route.indexOf('\n                leadProvider:',start);
 assert.ok(start>0&&end>start);
 const source=route.slice(start,end),shared=load('lib/chat/video-evidence.ts'),attachments=[fixture(3,[2])];
 for(const mode of ['ordinary','saved','clarification']){
  const assessment=vm.runInNewContext('({'+source+'})',{
   ...shared,createParams:()=>({user:'Read page 2',attachments,history:[]}),result:{model:'offline'},hasVideoInput:false,attachments,isVideoAttachment:()=>false,
   savedDraftOriginalTask:mode==='saved'?'Read page 2':null,pendingReviewClarification:mode==='clarification'?{pending:{sourceTurns:['Read page 2'],question:'Confirm page?'}}:null,
   message:'Page 2',mediaMemory:null,timelineContext:'',reviewSourceParams:{user:'CANDIDATE_DRAFT_SECRET'},
  }).assessmentParams;
  assert.match(assessment.user,/page 2/i);assert.ok(!JSON.stringify(assessment).includes('CANDIDATE_DRAFT_SECRET'));
  const context=formatAttachmentContext(assessment.attachments,{userMessage:assessment.user});
  assert.match(context,/CHUNK_PAGE_2/);onlyPages(context,[2],3);
 }
});

for(const message of ['Which pages mention revenue?','Summarize the pages about revenue','What do the pages say about revenue?','Find pages containing revenue','Read the pages describing cash flows','Review pages showing revenue'])test(`ordinary page prose retains bounded source evidence: ${message}`,()=>{
 const file=fixture(3);
 const out=rendered(file,message);
 assert.match(out,/CHUNK_PAGE_1/);assert.match(out,/LAYOUT_PAGE_1/);
 assert.doesNotMatch(out,/GLOBAL_(?:PREVIEW|FLAT|REPORT)_PAGE/);
});

test('source filenames stay data in extracted, layout and visual page scope',()=>{
 const a={...fixture(1,[1]),fileName:'report page 2.pdf'};
 assert.match(rendered(a,'Read report page 2.pdf'),/CHUNK_PAGE_1/);
 const b={...fixture(3,[3]),fileId:'other',fileName:'other page 9.pdf'};
 const output=formatAttachmentContext([{...a,...fixture(3,[3]),fileName:a.fileName},b],{userMessage:'Compare "report page 2.pdf" and "other page 9.pdf" on page 3'});
 assert.match(output,/CHUNK_PAGE_3/);onlyPages(output,[3],3);
});

test('comparison rendering supplies only each sources own qualified page',()=>{
 const a={...fixture(3,[2]),fileName:'a.pdf'},b={...fixture(6,[5]),fileName:'b.pdf',fileId:'other'};
 const text=formatAttachmentContext([a,b],{userMessage:'Compare "a.pdf" page 2 with "b.pdf" page 5'});
 const [left,right]=text.split('### ATTACHED FILE: b.pdf');
 assert.match(left,/CHUNK_PAGE_2/);assert.doesNotMatch(left,/CHUNK_PAGE_5/);
 assert.match(right,/CHUNK_PAGE_5/);assert.doesNotMatch(right,/CHUNK_PAGE_2/);
});

test('a terse review retry cannot reopen text after a failed original page scope',()=>{
 const file=fixture(6,[2]);
 file.pdfEvidence.state='failure';delete file.pdfEvidence.contextPages;
 const output=rendered(file,'yes');onlyPages(output,[],6);
 assert.doesNotMatch(output,/CHUNK_PAGE_|VISUAL_PAGE_|LAYOUT_PAGE_/);
});

test('Oxford-comma extraction scope retains the final requested page',()=>{
 const text=rendered(fixture(8,[2,4,6]),'Read pages 2, 4, and 6');
 for(const page of [2,4,6])assert.match(text,new RegExp(`CHUNK_PAGE_${page}`));
 onlyPages(text,[2,4,6],8);
});
