import test from 'node:test';
import assert from 'node:assert/strict';
import {modules} from './helpers/load-project-modules.mjs';

const {buildManagementDecisionContext,managementScope,selectManagementEvidenceIds}=
 modules()('@/lib/projects/management-context');
const uuid=n=>n.toString(16).padStart(8,'0')+'-0000-4000-8000-'+n.toString(16).padStart(12,'0');
const QA=uuid(2),PLAN=uuid(3),EXEC=uuid(4),ROOT=uuid(1);
const criteria=['same-commit browser gameplay','restart and reload reset','independent Preview review',
 'no forbidden features','developer and QA reporting separation'];
function makeNode(n,parent,kind='manager'){
 const name=n===QA?'Independent QA':n===ROOT?'Project Director':'QA subordinate '+n;
 const objective='Manage '+name+' with independently verifiable acceptance, approved scope and original owner objective.';
 const acceptance=criteria.map(c=>name+' must verify '+c+' using real saved evidence and exact Preview identity.');
 return {id:n,agent_id:uuid(100+Number.parseInt(n.slice(0,8),16)),parent_id:parent,kind,
  management_level:n===ROOT?'project_director':n===QA?'functional_director':'manager',
  name,area:n===QA?'independent_qa':'planning',status:'active',depth:parent?1:0,objective,
  acceptance,tools:['manage','analysis','research'],scope_paths:[],scope_hash:'approved-scope',
  deadline:'2026-11-26T19:45:00Z',token_limit:20000,
  management_contract:{purpose:'Own bounded management and evidence validation '+name,
   objectives:[objective],acceptance:structuredClone(acceptance),
   deliverables:criteria.map(c=>'Produce verifiable '+c),reporting:'Original managed hierarchy'}};
}
function fixture(){
 const root=makeNode(ROOT,null,'project_director');
 const qa=makeNode(QA,ROOT),planning=makeNode(PLAN,QA),execution=makeNode(EXEC,QA);
 const topology=[root,qa,planning,execution,
  ...Array.from({length:9},(_,i)=>({...makeNode(uuid(30+i),ROOT),kind:'manager'}))];
 const projectContract={path:'tests/milestone-3-tic-tac-toe/',
  acceptance:criteria.flatMap(c=>Array.from({length:8},(_,i)=>({
   criterion:'Verify '+c+' scenario '+i+' on the original protected same-commit Preview.',
   evidence:'Saved screenshots and repository verification with identity and exact committed content'})))};
 const project={objective:root.objective,team:[uuid(201),uuid(202),uuid(203)],
  approved_hash:'approved-scope',phase:'development',deadline:root.deadline,milestone_index:0,
  spec:{requirements:criteria.map(c=>'Original owner gameplay requirement: '+c),
   allowedPaths:['app/milestone-3-tic-tac-toe/','lib/milestone-3-tic-tac-toe/','tests/milestone-3-tic-tac-toe/'],
   milestones:[{instruction:'Deliver an independently verifiable tic-tac-toe game',contract:projectContract}],
   finalContract:projectContract}};
 const plans=[QA,PLAN].map((node_id,i)=>({node_id,
  purpose:'Preserve full QA independent acceptance, authentic review artifacts and reporting.',
  direction:'Commission no code. Preserve exact test matrix and reject unverifiable completion.',
  outcomes:Array.from({length:10},(_,j)=>({
   criterion:'QA acceptance '+j+' for '+criteria[j%criteria.length]+' including the current approved source and deadline.',
   verification:'Independent check against original owner acceptance and same deployment tree.'})),
  milestones:criteria.map(c=>({objective:'Verify '+c+' without changing inherited authority.'})),
  organizations:['qa-planning','qa-review']}));
 const exceptions=Array.from({length:47},(_,i)=>({
  id:uuid(300+i),origin_id:i%2?PLAN:EXEC,owner_id:i%3?QA:PLAN,
  reason:i%4===0?'objective':'routine',status:'open',
  detail:i%5===0?'Management session failed twice; saved decisions and charges retained.':
    'Unresolved independent QA '+i+' requires exact subordinate acceptance and source evidence. '+
    ('The manager cannot equate administrative readiness with completed verification. '+
     'Review the approved objective and the protected same-commit Preview. ').repeat(1),
  created_at:'2026-11-23T'+String(10+Math.floor(i/60)).padStart(2,'0')+':'+String(i%60).padStart(2,'0')+':00Z'
 }));
 const bindings=Array.from({length:38},(_,i)=>({
  assignment_id:uuid(700+i),node_id:i%3===0?QA:i%3===1?PLAN:EXEC,
  created_at:'2026-11-23T'+String(10+Math.floor(i/60)).padStart(2,'0')+':'+String(i%60).padStart(2,'0')+':00Z'}));
 const statuses=bindings.map((b,i)=>({id:b.assignment_id,
  status:i>=35?'failed':'completed'}));
 const scope=managementScope(topology,QA);
 const selected=selectManagementEvidenceIds(bindings,statuses,scope.decisionIds);
 const evidence=bindings.filter(b=>selected.includes(b.assignment_id)).map((b,i)=>({
  id:b.assignment_id,status:statuses.find(s=>s.id===b.assignment_id).status,
  mission_id:uuid(900+i),role:'work',agent_id:uuid(1000+i),
  instruction:'Execute only saved legitimate QA management and preserve every open exception identity.',
  payload:{organizationNodeId:b.node_id},dependencies:[],
  detail: i%2?'Required evidence unavailable':null,
  result:{detail:'Actual subordinate acceptance remains unverified; preserve the parent objective and deferred evidence.',
   diagnostic:{stage:'work',errorType:'Error',acceptedIssue:false}}}));
 const decisions=Array.from({length:14},(_,i)=>({
  id:uuid(1100+i),node_id:i%3===0?QA:i%3===1?PLAN:EXEC,
  assignment_id:bindings[i].assignment_id,created_at:'2026-11-23T15:'+String(i).padStart(2,'0')+':00Z',
  decision:[{action:'reject',nodeId:PLAN,reason:
   'Verify the original scope, approved acceptance, subordinate provenance and independent QA status. '.repeat(4)}]}));
 return {principalId:QA,topology,scopedNodes:[root,qa,planning,execution],project,
  executionTeam:project.team.map((id,i)=>({id,config:{name:'QA agent '+i,research:true,development:false,reviewMode:'independent'}})),
  exceptions,bindings,statuses,evidence,plans,dependencies:[],scopeGrants:[],
  workerContracts:[],workPackages:[],workPackageAttempts:[],work:[],decisions};
}
function restorePacked(c){
 const result=structuredClone(c),fields=c.exceptionFields,ids=c.exceptionNodeIds;
 // The final lossless dictionary tier may be needed only after further
 // history growth. Restore it before the existing positional-row decoder.
 if(Array.isArray(result.exceptionDetailFragments)){
  result.exceptions=result.exceptions.map(row=>{
   const r=[...row];
   r[3]=result.exceptionReasonValues[r[3]];
   r[5]=result.exceptionStatusValues[r[5]];
   r[6]=result.exceptionDateValues[r[6][0]]+r[6][1];
   if(Array.isArray(r[4])&&r[4][0]===null)
    r[4]=r[4].slice(1).map(p=>typeof p==='number'?result.exceptionDetailFragments[p]:p).join('');
   return r;
  });
  delete result.exceptionReasonValues;
  delete result.exceptionStatusValues;
  delete result.exceptionDateValues;
  delete result.exceptionDetailFragments;
 }
 assert.deepEqual(fields,['id','origin_id','owner_id','reason','detail','status','created_at','resolution','extraFields']);
 assert(Array.isArray(ids)&&ids.length>0);
 result.exceptions=c.exceptions.map((row,i)=>{
  const e={};
  for(let j=0;j<row.length;j++){
   if(j===8){Object.assign(e,row[j]);continue}
   if(j===7&&row[j]===null)continue;
   const k=fields[j];
   if(j===1||j===2)e[k]=ids[row[j]];
   else if(j===4&&Array.isArray(row[j])){
    assert.equal(row[j].length,1);assert(row[j][0]<i);
    e.detail=result.exceptions[row[j][0]][4];
   }else e[k]=row[j];
  }
  return e;
 });
 const pointer=p=>p.slice(2).split('/').reduce((v,key)=>v[key.replace(/~1/g,'/').replace(/~0/g,'~')],c);
 for(const n of [result.principal,...result.organization]){
  if(Array.isArray(n.management_contract?.objectives))
   n.management_contract.objectives=n.management_contract.objectives.map(v=>v?.$ref?pointer(v.$ref):v);
  if(n.management_contract?.acceptance?.$ref)n.management_contract.acceptance=pointer(n.management_contract.acceptance.$ref);
 }
 if(result.reporting.immediateSuperior?.objective?.$ref)
  result.reporting.immediateSuperior.objective=pointer(result.reporting.immediateSuperior.objective.$ref);
 delete result.exceptionFields;delete result.exceptionNodeIds;delete result.contextReferencePolicy;
 return result;
}
test('Mission85 recurring context overflow: lossless exception identity table preserves every open case',()=>{
 const x=fixture(),original=JSON.parse(buildManagementDecisionContext(x,200000));
 assert.ok(JSON.stringify(original).length>48000,'Reproduce existing capacity failure before final table representation');
 const packedText=buildManagementDecisionContext(x,48000);
 const packed=JSON.parse(packedText);
 assert.ok(Array.isArray(packed.exceptionFields),'Third-stage compaction is required');
 assert.equal(packed.exceptions.length,47);
 assert.equal(packed.evidence.length,original.evidence.length);
 assert.ok(packedText.length<=48000);
 assert.deepEqual(restorePacked(packed),original);
 assert.equal(packed.principal.objective,x.scopedNodes[1].objective);
 assert.equal(packed.project.approved_hash,x.project.approved_hash);
 console.log('MISSION85_EXCEPTION_TABLE_PASS '+JSON.stringify({rawChars:JSON.stringify(original).length,packedChars:packedText.length,exceptions:packed.exceptions.length,evidence:packed.evidence.length}));
});
test('Successive management growth preserves all identity, detail, status and assignment evidence until genuine capacity',()=>{
 const x=fixture();
 for(let wave=1;wave<=3;wave++){
  for(let i=0;i<2;i++)x.exceptions.push({
   id:uuid(2000+wave*2+i),origin_id:EXEC,owner_id:QA,status:'open',reason:'objective',
   detail:'Unique QA review '+wave+'/'+i+': verify protected Preview identity and preserve acceptance evidence.',
   created_at:'2026-11-24T'+String(wave).padStart(2,'0')+':00:00Z'
  });
  // Historic terminal assignments remain indexed without duplicating their full
  // immutable results in each new management decision.
  for(let i=0;i<2;i++){
   const assignment_id=uuid(3200+wave*2+i);
   x.bindings.push({assignment_id,node_id:i%2?PLAN:EXEC,created_at:'2026-01-01T00:00:00Z'});
   x.statuses.push({id:assignment_id,status:'completed'});
  }
  const before=JSON.parse(buildManagementDecisionContext(x,200000));
  const text=buildManagementDecisionContext(x,48000),ctx=JSON.parse(text);
  assert.equal(ctx.exceptions.length,47+2*wave);
  assert.deepEqual(restorePacked(ctx),before);
  console.log('MISSION85_GROWTH_WAVE_PASS '+JSON.stringify({wave,exceptions:ctx.exceptions.length,chars:text.length}));
 }
 // Genuine uniquely unrepresentable evidence must never be truncated, redacted,
 // summarized, or sent to any paid provider by this assembler.
 x.exceptions.push({id:uuid(3000),origin_id:EXEC,owner_id:QA,status:'open',reason:'objective',
  detail:'Unique mandatory source evidence '+'E'.repeat(90000),created_at:'2026-11-24T08:00:00Z'});
 assert.throws(()=>buildManagementDecisionContext(x,48000),/exceeds bounded context/);
});
