import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync('lib/memory/summarizer.ts','utf8');
async function run(finishReason, content) {
  const writes=[];
  const messages=Array.from({length:65},(_,i)=>({id:`m${i}`,role:i%2?'assistant':'user',content:`source ${i}`}));
  const module={exports:{}};
  const client=class {async post(){return {stop_reason:finishReason,content:[{type:'text',text:content}]};}};
  const admin={rpc:async(name,args)=>{assert.equal(name,'commit_intermediate_memory_checkpoint');writes.push(args);return {data:true,error:null};}};
  const store={getChatById:async()=>({actorId:'a'}),getIntermediateMemory:async()=>({version:2,summary:'saved',summarizedThroughMessageId:'m0',sourceMessageCount:1}),getRecentMessages:async()=>messages,setIntermediateMemory:async(...args)=>writes.push(args)};
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,
    {module,exports:module.exports,process:{env:{CLAUDE_API_KEY:'test-only'}},console:{error:()=>{},warn:()=>{}},require:name=>name.includes('standalone-accounting/activity')?{createActivityAccountingFetch:()=>()=>{throw Error('Unexpected HTTP in memory protocol fixture')}}:name.includes('standalone-accounting/context')?{isStandaloneAccountingError:()=>false}:name==='openai'?client:name.includes('persistence-store')?store:name.includes('memory-contract')?{SHORT_TERM_MESSAGE_LIMIT:60}:name.includes('supabase/admin')?{getSupabaseAdminClient:()=>admin}:{filterConversationalMessages:x=>x}});
  await module.exports.maybeUpdateSummary('c');
  return writes;
}
test('truncated intermediate summary never advances source cursor',async()=>assert.equal((await run('max_tokens','partial')).length,0));
test('empty intermediate summary never advances source cursor',async()=>assert.equal((await run('end_turn','')).length,0));
test('complete intermediate summary advances only through summarized messages',async()=>{
  const writes=await run('end_turn','complete');assert.equal(writes.length,1);assert.equal(writes[0].p_expected_cursor,'m0');assert.equal(writes[0].p_content.summarizedThroughMessageId,'m4');assert.equal(writes[0].p_content.summary,'complete');
});
