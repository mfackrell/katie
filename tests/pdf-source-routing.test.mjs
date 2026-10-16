import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
const native=createRequire(import.meta.url);
class Clock extends Date {constructor(...args){super(...(args.length?args:['2026-10-16T12:00:00Z']));}}
function modules(){
 const loaded=new Map();
 function load(file){
  if(loaded.has(file))return loaded.get(file);
  const exports={};loaded.set(file,exports);
  const require=name=>{
   if(name==='@/lib/data/supabase/admin')return {getSupabaseAdminClient:()=>{throw Error('A source selector must not issue a query');}};
   if(name.startsWith('@/'))return load(name.slice(2)+'.ts');
   return native(name);
  };
  vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require,Date:Clock,console});return exports;
 }
 return load;
}
const old={id:'old',chatId:'source',fileName:'report.pdf',mimeType:'application/pdf',createdAt:'2025-01-01T00:00:00Z'};
const recent={...old,id:'recent',chatId:'newer',createdAt:'2026-10-15T12:00:00Z'};
test('source dates constrain the actual production routing block rather than falling back to an old PDF',async()=>{
 const source=readFileSync('app/api/chat/route.ts','utf8');
 const start=source.indexOf('    let pdfMemoryDecision ='),end=source.indexOf('    const selectedBeforePruning =',start);
 assert.ok(start>0&&end>start);
 const load=modules(),select=load('lib/chat/pdf-source-selection.ts').selectPdfEvidenceSource;
 for(const message of ['Read my PDF uploaded yesterday','Read my PDF from two weeks ago']) {
  const result=await vm.runInNewContext(ts.transpileModule(`(async()=>{${source.slice(start,end)}return attachmentDecision;})()`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{
   selectPdfEvidenceSource:select,pdfSourceTask:message,pdfTaskContext:null,timelineActive:false,savedVideoFollowUp:null,
   catalog:[old],mediaMemory:{hits:[{attachment_id:'old',source_chat_id:'source'}]},newAttachments:[],attachmentHistory:[],timelineSelection:{},
   selectStoredAttachments:()=>{throw Error('Must not discard date restriction through fallback');},message,
  });
  assert.equal(result.selections.length,0);assert.match(result.clarification,/date range/);
 }
 const found=select('Read my PDF uploaded yesterday',[old,recent],[],0,new Clock());
 assert.equal(found.selections.length,1);assert.equal(found.selections[0].attachment.id,'recent');
});
test('explicit unresolved sources and duplicate names clarify instead of reusing arbitrary evidence',()=>{
 const select=modules()('lib/chat/pdf-source-selection.ts').selectPdfEvidenceSource;
 const hit={attachment_id:'old',source_chat_id:'source'};
 assert.ok(select('Read missing.pdf page 2',[old],[hit],0).clarification);
 assert.ok(select('Read unknownreport.pdf page 2',[old],[hit],0).clarification);
 assert.ok(select('Read “unknown report.pdf” page 2',[old],[hit],0).clarification);
 assert.ok(select('Read report.pdf page 2',[old,recent],[hit],0).clarification);
 assert.equal(select('Where is the revenue breakdown in report.pdf?',[old],[hit],0).selections[0].attachment.id,'old');
 assert.equal(select('Keep this PDF for later; tell me a joke',[old],[hit],0),null);
 assert.equal(select('Where is report.pdf?',[old],[hit],0),null);
});

test('literal filename metacharacters stay data rather than regular-expression syntax',()=>{
 const select=modules()('lib/chat/pdf-source-selection.ts').selectPdfEvidenceSource;
 for(const fileName of ['a+b.pdf','a(b).pdf','a[1].pdf','cash$.pdf','a?.pdf']) {
  const source={...old,fileName};
  const selection=select(`Read "${fileName}" page 2`,[source],[],0);
  assert.equal(selection?.selections[0]?.attachment.id,'old',fileName);
 }
});
