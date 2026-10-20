import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=readFileSync('lib/missions/model.ts','utf8');
function loadRouterFixture({failPrimary=false,allow=true}={}){
 let calls=[],reserve=[],chosen=0;
 const first={name:'google',generate:async p=>{calls.push(['google',p.modelId]);if(failPrimary){const err=Error('quota');err.status=429;err.code='insufficient_quota';throw err;}return{text:'valid model result',model:p.modelId,provider:'google',usage:{totalTokens:65}};}};
 const second={name:'anthropic',generate:async p=>{calls.push(['anthropic',p.modelId]);return{text:'recovered verified text',model:p.modelId,provider:'anthropic',usage:{totalTokens:72}};}};
 const out=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,exports={};
 const require=name=>name==='@/lib/providers'?{getAvailableProviders:()=>[first,second]}
 :name==='@/lib/router/master-router'?{chooseProvider:async()=>{chosen++;return{provider:first,modelId:'gemini-3.1-pro',fallbackChain:[{provider:second,modelId:'claude-sonnet-4-6',score:1}]};}}
 :name==='@/lib/missions/store'||name==='./store'?{rpc:async(n,a)=>{if(n==='reserve_mission_call'){reserve.push(a);return allow;}return true;}}
 :name==='node:crypto'?{randomUUID:()=>String(reserve.length+1)}
 :name==='openai'?{default:class{}}:name==='openai/helpers/zod'?{zodTextFormat:()=>({})}
 :name==='../../scripts/project-game-rules.mjs'?{GAME_RULE_CATEGORIES:[]}
 :name==='@/lib/projects/contract'?{projectPlanSchema:{omit:()=>({})}}
 :name==='./types'?{planSchema:{}}:{};
 vm.runInNewContext(out,{exports,require,process,Buffer,console,setTimeout,clearTimeout},{filename:'model.js'});
 const claim={mission:{id:'m',project_id:'p',objective:'Implement an original game',team:[{id:'agent',config:{research:false}}],project_kind:'specification'},job:{id:'job',agent_id:'agent',lease:'lease',role:'review'}};
 return{run:()=>exports.routedMissionText(claim,'Review independent specification','Saved exact candidate',6000),calls,reserve,chosen:()=>chosen};
}
test('mission router selects capable candidate before inference and preserves model evidence',async()=>{
 const t=loadRouterFixture();const result=await t.run();
 assert.equal(result.model,'google:gemini-3.1-pro');assert.equal(t.chosen(),1);
 assert.deepEqual(t.calls,[['google','gemini-3.1-pro']]);
 assert.equal(t.reserve.length,1);assert.equal(t.reserve[0].p_model,'google:gemini-3.1-pro');
});
test('mission router uses ranked chain only after eligible provider failure',async()=>{
 const t=loadRouterFixture({failPrimary:true});const result=await t.run();
 assert.equal(result.model,'anthropic:claude-sonnet-4-6');
 assert.deepEqual(t.calls.map(c=>c[0]),['google','anthropic']);
 assert.equal(t.reserve.length,2);
});
test('no provider call when mission budget disallows reservation',async()=>{
 const t=loadRouterFixture({allow:false});await assert.rejects(t.run(),/budget/);assert.equal(t.calls.length,0);
});
