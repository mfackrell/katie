import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import ts from 'typescript';import vm from 'node:vm';
const source=readFileSync('lib/missions/model.ts','utf8');
test('orchestrator credit failure fallback is precise and preserves original mission gates',()=>{
 const out=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const exports={};
 vm.runInNewContext(out,{exports,require:(name)=>name==='openai'?{default:class{}}:name==='@/lib/providers'?{getAvailableProviders:()=>[]}:name==='openai/helpers/zod'?{zodTextFormat:()=>({})}:name==='node:crypto'?{randomUUID:()=> 'id'}:name==='@/lib/missions/store'||name==='./store'?{rpc:async()=>false}:name==='@/lib/projects/contract'?{projectPlanSchema:{omit:()=>({})}}:name==='../../scripts/project-game-rules.mjs'?{GAME_RULE_CATEGORIES:[]}:name==='./types'?{planSchema:{}}:{},process,Buffer,console},{filename:'model.js'});
 const check=exports.isCreditExhaustion;
 assert.equal(check({status:429,code:'insufficient_quota',message:'You have no credits remaining'}),true);
 assert.equal(check({status:429,message:'rate limit exceeded'}),false);
 assert.equal(check({status:500,message:'internal error'}),false);
 assert.equal(check({status:401,message:'bad key'}),false);
 assert.match(source,/reserve_mission_call/);
 assert.match(source,/finish_mission_call/);
 assert.match(source,/orchestrationChoices/);
 assert.match(source,/failedProviders.add/);
 assert.doesNotMatch(source,/tools==='none'&&isCreditExhaustion/);
});