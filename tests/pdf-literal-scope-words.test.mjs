import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function load(file,imports={}){
 const exports={};
 vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:name=>imports[name]??{},Date});
 return exports;
}
const scope=load('lib/chat/pdf-source-selection.ts',{'@/lib/uploads/pdf-inventory':load('lib/uploads/pdf-inventory.ts')});
for(const [name,message] of [['all files.pdf','Read "all files.pdf"'],['all files.pdf','Read all files.pdf'],['both documents.pdf','Read “both documents.pdf”'],['only all PDFs.pdf','Read "only all PDFs.pdf"']])test(`filename words cannot authorize other files: ${message}`,()=>{
 const files=[{fileId:'selected',fileName:name,mimeType:'application/pdf'},{fileId:'other',fileName:'other.pdf',mimeType:'application/pdf'}];
 const result=scope.selectFreshPdfSources(message,files);
 assert.equal(result.clarification,undefined);
 assert.deepEqual([...result.fileIds],['selected']);
 const all=scope.selectFreshPdfSources(`Compare "${name}" with all other PDFs`,files);
 assert.equal(all.clarification,undefined);
 assert.deepEqual([...all.fileIds],['selected','other']);
});
