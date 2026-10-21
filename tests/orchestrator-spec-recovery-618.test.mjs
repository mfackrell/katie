import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { randomUUID, webcrypto } from 'node:crypto';
const native=createRequire(import.meta.url);
function modules(overrides={}){
 for(const [key,value] of Object.entries(overrides))if(key.startsWith('@/'))overrides[resolve(key.slice(2))]=value;
 const cache=new Map();
 const load=name=>{
  if(name in overrides)return overrides[name];
  if(!name.startsWith('@/')&&!name.startsWith('/')&&!name.startsWith('.'))return native(name);
  let path=name.startsWith('@/')?resolve(name.slice(2)):resolve(name);
  if(path.endsWith('.mjs'))return native(path);
  if(!path.endsWith('.ts'))path=existsSync(path+'.ts')?path+'.ts':resolve(path,'index.ts');
  if(cache.has(path))return cache.get(path);
  const exports={};cache.set(path,exports);
  const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  vm.runInNewContext(code,{exports,require:n=>n.startsWith('.')?load(resolve(dirname(path),n)):load(n),process,Buffer,Date,JSON,console,Set,Map,URL,URLSearchParams,TextEncoder,TextDecoder,Request,Response,Headers,ReadableStream,AbortController,AbortSignal,File,Blob,fetch,crypto:webcrypto,setTimeout,clearTimeout,setInterval,clearInterval},{filename:path});
  return exports;
 };
 return load;
}

import {gameFixture} from './fixtures/game-project.mjs';
const agent='11111111-1111-4111-8111-111111111111';
const brief='Exact original: "quoted" \\ backslash, newline\n🙂 '.repeat(22000).slice(0,22000);
const research='Source-supported finding. '.repeat(200);
const f=gameFixture();
const candidate={name:'Counter',summary:'Complete game',requirements:Array.from({length:28},(_,i)=>String(i)+' '+ 'R'.repeat(490)),allowedPaths:f.allowedPaths,milestones:[{title:'Complete',instruction:'Implement the original rules',contract:f.contract}],finalContract:f.contract,game:f.game};
const text=JSON.stringify(candidate);
const assessment={objective:'Exact source outcome',qualifications:['Game rules'],strongestEvidence:['Reviewed research'],criteria:['Verify every rule '+ 'criterion '.repeat(700)],synthesis:{conclusion:'Verify source coverage',dimensions:[{dimension:'Rules',supportedScope:'Complete rules',evidence:['Original brief']}],emphasis:'Complete outcome'},taskContract:{deliverable:'Specification',requirements:[{id:'all-rules',requirement:'Retain every explicit rule',sourceId:'latest-user',status:'active'}],conflicts:[]}};
const m={id:'mission',objective:'Specification phase. Read originalUserOutcome completely.',project_kind:'specification',project_evidence:{projectProfile:'game',originalUserOutcome:brief,reviewedResearch:{text:research,reviewedMissionId:'research'}},status:'running',team:[{id:agent,config:{instructions:'Use the exact rules'}}]};
const job=role=>({id:role,mission_id:m.id,job_key:role,role,agent_id:agent,instruction:'Complete phase',payload:{},lease:'lease',status:'running',attempts:1});
const compose={...job('compose'),status:'completed',result:{text}};

test('actual composition and both independent review passes preserve escaped source, research and full candidate at supported maximums',async()=>{
 let committed;const review=job('review'),calls=[];
 const store={readMission:async()=>({mission:m,jobs:[compose,review]}),rpc:async(_,args)=>{committed=args;return true;}};
 const load=modules({'@/lib/missions/store':store});
 const worker=load('@/lib/missions/worker');
 await worker.executeClaim({mission:m,job:job('compose')},async(_,instruction,input)=>{
  const data=JSON.parse(input);assert.equal(data.projectEvidence.originalUserOutcome,brief);assert.equal(data.projectEvidence.reviewedResearch.text,research);
  assert.ok(input.length<=48000);return{text,sources:[],calculations:[],model:'fixture'};
 });
 await worker.executeClaim({mission:m,job:review},async(claim,instruction,input)=>{
  calls.push(input);
  const isReview=instruction.includes('KATIE_REQUIRED_DRAFT_REVIEW');
  if(!isReview){const turns=JSON.parse(input.split('AUTHORITATIVE_USER_TURNS:\n')[1]);assert.ok(turns[1].text.endsWith(brief));assert.doesNotMatch(input,/Complete game/);}
  else{
   const data=JSON.parse(input.split('Evidence and candidate:\n')[1]);assert.equal(data.projectEvidence.originalUserOutcome,brief);assert.equal(data.projectEvidence.reviewedResearchText,research);
   assert.deepEqual(data.candidate.result.specification.game.rules,candidate.game.rules);
   assert.deepEqual(data.candidate.result.specification.finalContract,candidate.finalContract);
   const budget=load('@/lib/missions/request-budget');assert.ok(input.length>48000,'Exercise the formerly contradictory 48K envelope');
   assert.equal(budget.fitsMissionEnvelope(instruction,input,budget.missionInputLimit(claim)),true);
  }
  const ids=load('@/lib/collaboration/review-contract').acceptanceIds(assessment);
  return{text:JSON.stringify(isReview?{verdict:'approve',findings:'Every rule and expected state checked',checks:ids.map(id=>({id,passed:true,evidence:'Exact original source and complete candidate match'}))}:assessment),sources:[],calculations:[],model:'independent-fixture'};
 });
 assert.equal(calls.length,2);assert.equal(committed.p_final,text);assert.equal(committed.p_mission_status,'completed');assert.equal(compose.result.text,text);
});

test('shared serialization counts escapes, Unicode and metadata before child admission',()=>{
 const {jsonbTextSize}=modules()('@/lib/projects/game-evidence');
 const data={originalUserOutcome:brief,reviewedResearch:{text:research},recovery:{id:'original',findings:'"\\\n'.repeat(200)}};
 assert.ok(jsonbTextSize(data)>brief.length+research.length);
 const n=jsonbTextSize({value:''});assert.equal(jsonbTextSize({value:'x'.repeat(30000-n)}),30000);assert.equal(jsonbTextSize({value:'x'.repeat(30001-n)}),30001);
});
