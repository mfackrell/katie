import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
const native=createRequire(import.meta.url);
function selector(){
 const modules=new Map();
 const load=file=>{
  if(modules.has(file))return modules.get(file);
  const exports={};modules.set(file,exports);
  const require=name=>{
   if(name==='@/lib/data/supabase/admin')return {getSupabaseAdminClient:()=>{throw Error('Source selection must not fetch or infer');}};
   if(name.startsWith('@/'))return load(name.slice(2)+'.ts');
   return native(name);
  };
  vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require,Date,console});
  return exports;
 };
 return load('lib/chat/pdf-source-selection.ts').selectPdfEvidenceSource;
}
const now=new Date('2026-10-16T12:00:00Z');
const old={id:'old',chatId:'source-old',fileName:'report.pdf',mimeType:'application/pdf',createdAt:'2025-01-01T00:00:00Z'};
const other={id:'other',chatId:'source-other',fileName:'other.pdf',mimeType:'application/pdf',createdAt:'2026-10-15T12:00:00Z'};
const otherHit={attachment_id:other.id,source_chat_id:other.chatId};
for(const message of [
 'Read report.pdf uploaded yesterday',
 'Read my PDF report.pdf uploaded yesterday',
 'Read report.pdf and other.pdf uploaded yesterday',
 'Read “report.pdf” uploaded yesterday',
 'Read report.pdf uploaded from 2026-10-15 to 2026-10-15',
])test(`literal source and date remain binding: ${message}`,()=>{
 const select=selector();
 for(const hits of [[],[otherHit]]){
  const decision=select(message,[old,other],hits,0,now);
  assert.equal(decision.selections.length,0);
  assert.match(decision.clarification,/explicitly named PDF.*date range/);
 }
});
test('date filters may disambiguate duplicate names without substituting a different file',()=>{
 const select=selector(),recent={...other,id:'recent-same-name',fileName:'report.pdf'};
 const decision=select('Read report.pdf uploaded yesterday',[old,recent,other],[otherHit],0,now);
 assert.equal(decision.selections.length,1);assert.equal(decision.selections[0].attachment.id,recent.id);
});
test('literal identity without a date and generic dated lookup keep their respective semantics',()=>{
 const select=selector();
 assert.equal(select('Read report.pdf',[old,other],[otherHit],0,now).selections[0].attachment.id,old.id);
 assert.equal(select('Read my PDF uploaded yesterday',[old,other],[otherHit],0,now).selections[0].attachment.id,other.id);
 assert.equal(select('Read report.pdf uploaded yesterday',[old,other],[otherHit],1,now),null);
});

test('document dates do not become upload-date filters for named saved or fresh sources',()=>{
 const select=selector();
 for(const message of ['What was revenue in 2024 in report.pdf?','Read report.pdf and explain revenue in 2024','What happened yesterday in report.pdf?']) {
  const saved=select(message,[old],[],0,now);assert.equal(saved.clarification,undefined);assert.equal(saved.selections[0].attachment.id,'old');
  assert.equal(select(message,[old],[],1,now,[{...old,fileId:'new'}]),null);
 }
 const dated=select('Read report.pdf uploaded yesterday and explain revenue in 2024',[{...old,createdAt:'2026-10-15T12:00:00Z'}],[],0,now);
 assert.equal(dated.clarification,undefined);assert.equal(dated.selections[0].attachment.id,'old');
});
