import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {loadFullBenchmarkBinding} from '../scripts/benchmark/full-project-gate.mjs';
const source=readFileSync('app/api/chat/route.ts','utf8');
const start=source.indexOf('    const benchmarkIntake =');
const end=source.indexOf('    const repoInjectionEnabled =',start);
assert.ok(start>0&&end>start);
const code=ts.transpileModule(`async function gate(){${source.slice(start,end)}return {benchmarkRelay,benchmarkIntake};}exports.gate=gate;`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
async function run(message,{bound=false,attachments=false,disabled=false,error=false}={}){
 const exports={};let reads=0;
 const db={from:()=>({select(){return this},eq(){return this},async maybeSingle(){reads++;return {data:bound?{trial_id:'full-trial'}:null,error:error?{}:null}}})};
 vm.runInNewContext(code,{exports,message,currentAgentTask:()=>null,
  startProjectIntent:m=>/^Build /.test(m),gameProjectIntent:m=>/game/.test(m),
  projectForChat:async()=>bound?{id:'project'}:null,loadFullBenchmarkBinding,
  getSupabaseAdminClient:()=>db,actorId:'actor',chatId:'chat',fileReferences:attachments?[{}]:[],requestImages:[],
  NextResponse:{json:(body,{status})=>({body,status})},process:{env:{NEXT_PUBLIC_SUPABASE_URL:'https://barclcqataqyvifoeyop.supabase.co',KATIE_FULL_BENCHMARK_ENVIRONMENT:'production',KATIE_FULL_BENCHMARK_DISPATCH:disabled?'':'enabled',KATIE_NATIVE_BENCHMARK_DISPATCH:'enabled',KATIE_FULL_BENCHMARK_TRIAL_ID:'full-trial'}}});
 return {result:await exports.gate(),reads};
}
test('real route discovers Full binding for every follow-up, before any attachment hydration or classifier',async()=>{
 assert.ok(end<source.indexOf('await hydrateStoredAttachments'));
 for(const message of ['Resume project','Continue the project','Project status','Add undo button to the game','Tell me a joke']){
  const {result,reads}=await run(message,{bound:true});assert.equal(result.benchmarkRelay,true);assert.equal(reads,1);
 }
 assert.equal((await run('Build a browser game called Take Eleven')).result.benchmarkRelay,true);
 assert.equal((await run('Tell me a joke')).result.benchmarkRelay,false);
});
test('real route rejects attachment intake and disabled or unreadable bindings without model fallback',async()=>{
 assert.equal((await run('Build a browser game called Take Eleven',{attachments:true})).result.status,400);
 assert.equal((await run('Resume project',{bound:true,attachments:true})).result.status,400);
 await assert.rejects(run('Resume project',{bound:true,disabled:true}),/not authorized/);
 await assert.rejects(run('Resume project',{bound:true,error:true}),/failed closed/);
});
test('both prebinding classifier and all saved-source selector paths are excluded from benchmark relay',()=>{
 assert.match(source,/if \(!benchmarkRelay && !isProjectStopRequest/);
 assert.match(source,/const catalog = benchmarkRelay \|\|/);
 assert.match(source,/if \(!benchmarkRelay && pdfMemoryDecision\?\.selections.length/);
 assert.match(source,/AttachmentDecision = benchmarkRelay \? \{method: "none", selections: \[\]\}/);
 assert.match(source,/benchmarkRelay \? \{reason: "project" as const,text:.*unmetered chat inference is disabled/);
});
