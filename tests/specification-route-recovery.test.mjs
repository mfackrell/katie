import test from 'node:test';
import assert from 'node:assert/strict';
import {modules} from './helpers/load-project-modules.mjs';
import {gameFixture} from './fixtures/game-project.mjs';
const load=modules(),{repairSpecificationRoute}=load('@/lib/projects/specification-route-recovery');
function fixture(){
 const f=gameFixture();f.game.acceptance.scenarios.find(s=>s.kind==='browser').steps.unshift({action:'goto',path:'/counter'});
 return {specificationFormat:'registered-game-v1',name:'Counter',summary:'Controlled counter',requirements:['Increment and reject invalid actions'],allowedPaths:['app/counter/','tests/counter.mjs'],milestones:[{title:'Complete counter',instruction:'Implement all requirements'}],finalContract:{path:'tests/counter.mjs'},game:f.game};
}
const scope='Scope ONLY app/counter/ and tests/counter.mjs.';
test('one source-file route correction fixes both expanded contracts with full canonical validation',()=>{
 const raw=fixture(),source=JSON.stringify(raw),r=repairSpecificationRoute(source,scope);
 assert.ok(r);assert.equal(r.plan.finalContract.path,'/counter');assert.equal(r.plan.milestones[0].contract.path,'/counter');
 assert.deepEqual(JSON.parse(r.correctedText),{...raw,finalContract:{path:'/counter'}});
 assert.equal(JSON.stringify(raw),source);assert.deepEqual(JSON.parse(JSON.stringify(r.plan.game)),raw.game);
 assert.deepEqual(JSON.parse(JSON.stringify(r.correction)),{pointer:'/finalContract/path',before:'tests/counter.mjs',after:'/counter'});
 assert.equal(repairSpecificationRoute(r.correctedText,scope),null,'already-correct paths never rewritten');
});
test('ambiguous scope, missing provenance and contradictory navigation refuse inference',()=>{
 const source=JSON.stringify(fixture());
 for(const s of ['',scope+' app/other/',scope+' app/counter/[id]/',scope+' app/counter/../','Scope app/counter/ only','Scope app/[dynamic]/ and tests/counter.mjs.'])assert.equal(repairSpecificationRoute(source,s),null,s);
 const raw=fixture();raw.game.acceptance.scenarios.find(s=>s.kind==='browser').steps[0].path='/other';assert.equal(repairSpecificationRoute(JSON.stringify(raw),scope),null);
 raw.game.acceptance.scenarios.find(s=>s.kind==='browser').steps.shift();assert.equal(repairSpecificationRoute(JSON.stringify(raw),scope),null);
});
test('route repair never hides other canonical validation failures or rewrites valid routes',()=>{
 const raw=fixture();raw.summary='';assert.throws(()=>repairSpecificationRoute(JSON.stringify(raw),scope));
 const other=fixture();other.finalContract.path='/different';assert.equal(repairSpecificationRoute(JSON.stringify(other),scope),null);
 const duplicate=fixture();duplicate.milestones[0].contract={path:'/other'};assert.throws(()=>repairSpecificationRoute(JSON.stringify(duplicate),scope));
});
test('maintenance sends full source compare-and-swap and validated output without a model',async()=>{
 const source=JSON.stringify(fixture()),original={rejectedSpecification:source,admissionDenied:true};const calls=[];
 const db={from(table){return {select(){return this;},eq(){return this;},maybeSingle:async()=>({data:{id:'p',objective:scope,clarifications:'',active_mission_id:'m',status:'blocked',phase:'specification'}}),returns:async()=>({data:[{id:'j',result:original}]})};}};
 const runtime=modules({'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db},'@/lib/projects/store':{projectRpc:async(name,args)=>{calls.push({name,args});return true;}}});
 assert.equal(await runtime('@/lib/projects/specification-route-recovery').recoverSpecificationRoute('p'),true);
 assert.equal(calls.length,1);assert.equal(calls[0].name,'recover_specification_route');assert.equal(calls[0].args.p_source,source);assert.equal(calls[0].args.p_original,original);assert.equal(calls[0].args.p_plan.finalContract.path,'/counter');
});

test('directory paths are not source-file category errors',()=>{const raw=fixture();raw.finalContract.path='app/counter/';assert.equal(repairSpecificationRoute(JSON.stringify(raw),scope),null);});
