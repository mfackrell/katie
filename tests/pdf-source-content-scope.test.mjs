import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
const native=createRequire(import.meta.url);
function load(file,cache=new Map()){
 if(cache.has(file))return cache.get(file);
 const exports={};cache.set(file,exports);
 const require=name=>name==='@/lib/data/supabase/admin'?{getSupabaseAdminClient:()=>{throw Error('No source-selection I/O');}}:name.startsWith('@/')?load(name.slice(2)+'.ts',cache):native(name);
 vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require,Date,console});return exports;
}
const scope=load('lib/chat/pdf-source-selection.ts');
const files=[{fileId:'short',id:'short',chatId:'chat',fileName:'report.pdf',mimeType:'application/pdf'},
 {fileId:'long',id:'long',chatId:'chat',fileName:'annual report.pdf',mimeType:'application/pdf'},
 {fileId:'text',id:'text',chatId:'chat',fileName:'notes.txt',mimeType:'text/plain'}];
for(const message of ['Calculate the total from annual report.pdf','Summarize the revenue in annual report.pdf','Extract every transaction from annual report.pdf','Explain the table in annual report.pdf'])test(`content-task source remains unambiguous: ${message}`,()=>{
 const fresh=scope.selectFreshPdfSources(message,files);
 assert.equal(fresh.clarification,undefined);assert.deepEqual([...fresh.fileIds],['long']);
 const saved=scope.selectPdfEvidenceSource(message,files,[],0);
 assert.equal(saved.clarification,undefined);assert.equal(saved.selections[0].attachment.id,'long');
});
for(const message of ['Summarize notes.txt','Read notes.txt','Calculate the total from notes.txt'])test(`named non-PDF task cannot trigger PDF clarification: ${message}`,()=>{
 const fresh=scope.selectFreshPdfSources(message,files);
 assert.equal(fresh.clarification,undefined);assert.equal(fresh.fileIds.size,0);
});
test('explicit PDF and whole-set requests retain mixed-upload selection',()=>{
 for(const message of ['Compare notes.txt with all PDFs','Summarize all attached documents'])assert.deepEqual([...scope.selectFreshPdfSources(message,files).fileIds],['short','long']);
 assert.deepEqual([...scope.selectFreshPdfSources('Read report.pdf',files).fileIds],['short']);
 assert.ok(scope.selectFreshPdfSources('Read missing.pdf and notes.txt',files).clarification);
 assert.ok(scope.selectFreshPdfSources('Calculate the total from quarterly report.pdf',files).clarification);
});
