import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function load(file,imports={}){
 const exports={};
 vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:name=>imports[name]??{},Date});return exports;
}
const {selectFreshPdfSources}=load('lib/chat/pdf-source-selection.ts',{'@/lib/uploads/pdf-inventory':load('lib/uploads/pdf-inventory.ts')});
const pdf=(fileId,fileName)=>({fileId,fileName,mimeType:'application/pdf'});
const sources=[pdf('selected','report.pdf'),pdf('other','other.pdf'),{fileId:'media',fileName:'recording',mimeType:'video/mp4'}];
for(const medium of ['video','screenshot','audio'])test(`source-qualified document set cannot widen a named PDF selection: ${medium}`,()=>{
 for(const group of ['all documents in','all PDFs shown in','all files discussed in','both documents visible in','all attachments contained within']){
  const decision=selectFreshPdfSources(`Compare report.pdf with ${group} the ${medium}`,sources);
  assert.equal(decision.clarification,undefined);
  assert.deepEqual([...decision.fileIds],['selected']);
 }
});
test('unqualified uploaded sets and separately requested all-PDF comparisons remain supported',()=>{
 for(const message of ['Compare report.pdf with all other PDFs','Read all attached files','Inspect all uploaded documents','Compare the video with all PDFs']){
  const decision=selectFreshPdfSources(message,sources);
  assert.equal(decision.clarification,undefined);
  assert.deepEqual([...decision.fileIds],['selected','other']);
 }
 const unrelated=selectFreshPdfSources('Summarize all files in the video',sources);
 assert.equal(unrelated.clarification,undefined);assert.equal(unrelated.fileIds.size,0);
});
