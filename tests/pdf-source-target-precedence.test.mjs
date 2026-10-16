import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
const native=createRequire(import.meta.url);
const cache=new Map();
function load(file){
 if(cache.has(file))return cache.get(file);
 const exports={};cache.set(file,exports);
 const require=name=>name==='@/lib/data/supabase/admin'?{getSupabaseAdminClient:()=>{throw Error('Selection must not access data or providers');}}:name.startsWith('@/')?load(name.slice(2)+'.ts'):native(name);
 vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require,Date,console});return exports;
}
const scope=load('lib/chat/pdf-source-selection.ts');
const pdf=(name,id=name)=>({id,fileId:id,chatId:'chat',fileName:name,mimeType:'application/pdf'});
for(const [message,mime] of [
 ['Summarize the statements in the video','video/mp4'],
 ['Summarize all documents in the video','video/mp4'],
 ['Read the invoices shown in the screenshot','image/png'],
 ['Summarize the documents discussed in the audio','audio/mpeg'],
 ['Explain the statements in notes.txt','text/plain'],
])test(`a content noun does not override the named medium: ${message}`,()=>{
 const target={fileId:'target',fileName:mime==='text/plain'?'notes.txt':'media',mimeType:mime};
 for(const count of [1,2]){
  const files=[...Array.from({length:count},(_,i)=>pdf(`report${i}.pdf`)),target];
  const result=scope.selectFreshPdfSources(message,files);
  assert.equal(result.clarification,undefined);assert.equal(result.fileIds.size,0);
 }
});
for(const name of ['not files.pdf','without documents.pdf','ignore PDFs.pdf'])test(`unquoted source spans are masked before exclusions: ${name}`,()=>{
 const files=[pdf(name,'selected'),pdf('other.pdf','other')];
 const result=scope.selectFreshPdfSources(`Read ${name}`,files);
 assert.equal(result.clarification,undefined);assert.deepEqual([...result.fileIds],['selected']);
 const saved=scope.selectPdfEvidenceSource(`Read ${name}`,files,[],0);
 assert.equal(saved.clarification,undefined);assert.equal(saved.selections[0].attachment.id,'selected');
 assert.ok(scope.selectFreshPdfSources(`Read "${name}", ignore "other.pdf"`,files).clarification);
});
test('explicit PDF and whole-upload targets retain precedence when actually requested',()=>{
 const files=[pdf('report.pdf'),pdf('other.pdf'),{fileId:'video',fileName:'clip.mp4',mimeType:'video/mp4'}];
 for(const message of ['Compare the video with all PDFs','Compare all attached files','Summarize all uploaded documents']){
  const result=scope.selectFreshPdfSources(message,files);
  assert.equal(result.clarification,undefined);assert.deepEqual([...result.fileIds],['report.pdf','other.pdf']);
 }
 assert.deepEqual([...scope.selectFreshPdfSources('Compare report.pdf with the video',files).fileIds],['report.pdf']);
});
