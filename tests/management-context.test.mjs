import test from 'node:test';
import assert from 'node:assert/strict';
import {modules} from './helpers/load-project-modules.mjs';
const {managementScope,selectManagementEvidenceIds,buildManagementDecisionContext}=modules()('@/lib/projects/management-context');

const node=(id,parent=null,kind='manager',extra={})=>({
 id,agent_id:'agent-'+id,parent_id:parent,kind,management_level:kind==='project_director'?'project_director':'manager',
 objective:'Manage '+id,acceptance:['Preserve the original scope'],tools:['manage','analysis'],
 deadline:'2026-11-13T16:00:00Z',management_contract:{required:'verified child acceptance'},
 status:'active',...extra
});
function fixture(){
 const root=node('root',null,'project_director'),game=node('game','root'),qa=node('qa','root'),
 child=node('child','game'),worker=node('worker','child','worker');
 const topology=[root,game,qa,child,worker];
 const exceptions=[{id:'exception-game',origin_id:'game',owner_id:'root',status:'open',detail:'Development authority missing'},
 {id:'exception-qa',origin_id:'qa',owner_id:'root',status:'open',detail:'Independent QA must remain separate'},
 {id:'archived',origin_id:'qa',owner_id:'root',status:'resolved',detail:'Resolved prior issue'}];
 const bindings=[{assignment_id:'old',node_id:'game',created_at:'2026-11-01T00:00:00Z'},
  {assignment_id:'latest',node_id:'game',created_at:'2026-11-12T00:00:00Z'}];
 const statuses=[{id:'old',status:'completed'},{id:'latest',status:'completed'}];
 const evidence=[{id:'latest',status:'completed',mission_id:'mission-new',result:{detail:'The completed deliverable is saved'} }];
 return {principalId:'root',topology,scopedNodes:[root,game,qa],project:{objective:'Build a bounded original game',deadline:root.deadline,approved_hash:'hash',phase:'research'},
 executionTeam:[{id:'agent-root',config:{name:'Root',research:false,development:false,reviewMode:'always'}}],
 exceptions,bindings,statuses,evidence,plans:[{node_id:'root',purpose:'Owner purpose',direction:'Delegate delivery'}],
 dependencies:[{node_id:'game',depends_on:'qa'}],scopeGrants:[],workerContracts:[],workPackages:[],workPackageAttempts:[],work:[]};
}
test('regression: legacy project-wide evidence overflows 48k while current manager keeps owner objective and direct contracts',()=>{
 const x=fixture();
 for(let i=0;i<700;i++)x.topology.push(node('unrelated-'+i,'child','manager',{objective:'Archived organization '.repeat(18)}));
 const legacy=JSON.stringify({project:x.project,principal:x.scopedNodes[0],organization:x.topology,plans:x.plans,evidence:x.evidence,assignments:x.bindings});
 assert.ok(legacy.length>48000,'The project-wide serializer must reproduce the original overflow');
 const text=buildManagementDecisionContext(x,48000),ctx=JSON.parse(text);
 assert.ok(text.length<48000);
 assert.equal(ctx.project.objective,x.project.objective);
 assert.equal(ctx.principal.id,'root');
 assert.deepEqual(ctx.organization.map(n=>n.id),['game','qa']);
 assert.equal(ctx.reporting.organizationNodeCount,705);
 assert.deepEqual(ctx.reporting.directReportIds,['game','qa']);
 assert.equal(ctx.evidence[0].id,'latest');
 assert.equal(ctx.evidence.length,1);
 assert.deepEqual(ctx.dependencies,[{node_id:'game',depends_on:'qa'}]);
 assert.equal(ctx.exceptions.length,2);
 assert.equal(ctx.historyReferences.omittedHistoricalAssignments,1);
});
test('completed history grows without changing the manager input; latest accepted evidence is selected by provenance',()=>{
 const x=fixture();
 const original=buildManagementDecisionContext(x);
 for(let i=0;i<2500;i++){
  const id='history-'+i;
  x.bindings.unshift({assignment_id:id,node_id:'game',created_at:'2025-01-01T00:00:00Z'});
  x.statuses.push({id,status:'completed'});
  // The full historical results remain saved but are not re-fetched into context.
 }
 const after=buildManagementDecisionContext(x);
 const ctx=JSON.parse(after);
 assert.equal(ctx.evidence[0].id,'latest');
 assert.ok(Math.abs(after.length-original.length)<120,'Only aggregate history metadata may grow');
 assert.equal(ctx.historyReferences.omittedHistoricalAssignments,2501);
 assert.equal(ctx.historyReferences.byNode.find(n=>n.nodeId==='game').completed,2502);
});
test('nested management depth preserves exact ancestors and only the immediate superior/direct reports',()=>{
 const root=node('root',null,'project_director'),a=node('a','root'),b=node('b','a','manager',{evidence:'Archived parent result '.repeat(5000)}),c=node('c','b'),worker=node('worker','c','worker');
 const x=fixture();x.principalId='c';x.topology=[root,a,b,c,worker];x.scopedNodes=[b,c,worker];
 x.bindings=[];x.statuses=[];x.evidence=[];x.dependencies=[];x.exceptions=[];x.plans=[];
 const ctx=JSON.parse(buildManagementDecisionContext(x));
 assert.equal(ctx.principal.id,'c');
 assert.equal(ctx.reporting.immediateSuperior.id,'b');
 assert.deepEqual(ctx.reporting.ancestors.map(n=>n.id),['b','a','root']);
 assert.deepEqual(ctx.reporting.directReportIds,['worker']);
 assert.deepEqual(ctx.organization.map(n=>n.id),['worker']);
 assert.ok(!JSON.stringify(ctx).includes('Archived parent result'));
 assert.ok(JSON.stringify(ctx).length<48000);
 assert.ok(!ctx.organization.some(n=>n.id==='a'||n.id==='root'));
});
test('unresolved owned exceptions, external dependency statuses and current activity cannot silently disappear',()=>{
 const x=fixture();
 x.exceptions.push({id:'unrelated',origin_id:'qa-deep',owner_id:'someone-else',status:'open',detail:'Not this reporting chain'});
 x.dependencies.push({node_id:'game',depends_on:'external'});
 x.topology.push(node('external','game','manager',{status:'blocked'}));
 x.bindings.push({assignment_id:'pending',node_id:'qa',created_at:'2026-11-12T04:00:00Z'});
 x.statuses.push({id:'pending',status:'running'});
 x.evidence.push({id:'pending',status:'running',mission_id:'mission-running'});
 const ctx=JSON.parse(buildManagementDecisionContext(x));
 assert.deepEqual(ctx.exceptions.map(e=>e.id),['exception-game','exception-qa']);
 assert.equal(ctx.externalDependencyStatuses[0].id,'external');
 assert.equal(ctx.externalDependencyStatuses[0].status,'blocked');
 assert.ok(ctx.evidence.some(e=>e.id==='pending'));
 assert.ok(ctx.assignments.some(e=>e.assignment_id==='pending'));
});
test('missing essential evidence fails before inference; no silent truncation or unauthorized decisions',()=>{
 const x=fixture();
 assert.throws(()=>buildManagementDecisionContext({...x,evidence:[]}),/selected assignment evidence/);
 assert.throws(()=>buildManagementDecisionContext({...x,statuses:[]}),/unreadable assignment status/);
 assert.throws(()=>buildManagementDecisionContext({...x,scopedNodes:[x.scopedNodes[0]]}),/immediate management contract/);
 assert.throws(()=>buildManagementDecisionContext({...x,project:{objective:''}}),/original owner objective/);
 assert.throws(()=>buildManagementDecisionContext({...x,dependencies:[{node_id:'game',depends_on:'missing'}]}),/unknown dependency/);
 x.exceptions.push({id:'huge',origin_id:'game',owner_id:'root',status:'open',detail:'E'.repeat(48000)});
 assert.throws(()=>buildManagementDecisionContext(x,48000),/exceeds bounded context/);
});
test('reporting cycle and worker management are not treated as delegable management',()=>{
 const x=fixture();
 assert.throws(()=>managementScope([node('a','b'),node('b','a')],'a'),/reporting cycle/);
 assert.throws(()=>managementScope(x.topology,'worker'),/missing management principal/);
 assert.throws(()=>managementScope([node('child','missing')],'child'),/missing reporting ancestor/);
});
test('selected evidence retains active assignments and only the latest terminal outcomes per report',()=>{
 const bs=[{assignment_id:'one',node_id:'child',created_at:'2026-01-01'},
 {assignment_id:'two',node_id:'child',created_at:'2026-02-01'},
 {assignment_id:'three',node_id:'child',created_at:'2026-03-01'},
 {assignment_id:'four',node_id:'root',created_at:'2026-04-01'},
 {assignment_id:'five',node_id:'child',created_at:'2026-04-02'}];
 const states=[{id:'one',status:'failed'},{id:'two',status:'completed'},{id:'three',status:'running'},
 {id:'four',status:'completed'},{id:'five',status:'failed'}];
 assert.deepEqual([...selectManagementEvidenceIds(bs,states,['root','child'])],['three','two','five'].sort());
 assert.throws(()=>selectManagementEvidenceIds(bs,states.slice(1),['root','child']),/unreadable assignment status/);
});

test('paginated management evidence loads every historical row and fails closed on a broken page',async()=>{
 const {completeManagementRows}=modules()('@/lib/projects/organization');
 const source=Array.from({length:421},(_,i)=>({id:String(i).padStart(4,'0'),value:'verified'}));
 let calls=0;
 const factory=()=>{let from=0,to=199;const q={
  order(){return q;},range(a,b){from=a;to=b;return q;},
  then(resolve,reject){calls++;return Promise.resolve({data:source.slice(from,to+1),error:null}).then(resolve,reject);}
 };return q;};
 const rows=await completeManagementRows(factory,'id');
 assert.equal(rows.length,421);
 assert.equal(calls,3);
 assert.equal(rows[0].id,'0000');
 assert.equal(rows.at(-1).id,'0420');
 await assert.rejects(completeManagementRows(()=>({then(resolve){return Promise.resolve({data:null,error:{message:'incomplete'}}).then(resolve);}}),'id'),/database page unavailable/);
});

test('retired package history never consumes the current decision window; active contract and latest attempt remain',()=>{
 const x=fixture();
 x.workPackages=[
  {id:'accepted',manager_id:'game',status:'accepted',evidence:'archived acceptance '.repeat(4000)},
  {id:'cancelled',manager_id:'game',status:'cancelled',findings:'discarded '.repeat(4000)},
  {id:'open',manager_id:'game',status:'rejected',contract_hash:'contract-sha'}];
 // Use the actual PostgreSQL row shape: no id or timestamp field.
 x.workPackageAttempts=[
  {package_id:'accepted',attempt:1,mission_id:'archived-mission',base_sha:'archived'},
  {package_id:'open',attempt:1,mission_id:'first-mission',base_sha:'first'},
  {package_id:'open',attempt:2,mission_id:'latest-mission',base_sha:'latest'},
 ];
 const context=JSON.parse(buildManagementDecisionContext(x));
 assert.deepEqual(context.workPackages.map(p=>p.id),['open']);
 assert.equal(context.acceptedPackageCount,1);
 assert.equal(context.historyReferences.retiredPackageCount,2);
 assert.equal(context.workPackageAttempts.length,1);
 assert.equal(context.workPackageAttempts[0].attempt,2);
 assert.equal(context.workPackageAttempts[0].mission_id,'latest-mission');
 x.workPackageAttempts.reverse();
 assert.equal(JSON.parse(buildManagementDecisionContext(x)).workPackageAttempts[0].attempt,2);
 x.workPackageAttempts.push({package_id:'open',attempt:0,mission_id:'invalid',base_sha:'invalid'});
 assert.throws(()=>buildManagementDecisionContext(x),/invalid package attempt ordinal/);
 assert.ok(!JSON.stringify(context).includes('archived acceptance'));
});

test('current approved contract and latest failures survive ready and replacement decisions',()=>{
 const x=fixture();x.project={...x.project,phase:'development',milestone_index:0,spec:{requirements:['Original requirement'],allowedPaths:['app/game/'],milestones:[{instruction:'Original approved implementation',contract:{path:'/game'}}],finalContract:{path:'/game'}}};
 x.bindings.push({assignment_id:'failed',node_id:'game',created_at:'2026-11-11T00:00:00Z'});
 x.statuses.push({id:'failed',status:'failed'});x.evidence.push({id:'failed',status:'failed',detail:'Missing development capability'});
 x.decisions=[{id:'replacement',node_id:'root',created_at:'2026-11-10',decision:[{action:'replace_leader',nodeId:'game'}]},
 ...Array.from({length:100},(_,i)=>({id:String(i),node_id:'root',created_at:'2026-11-12',decision:[{action:'ready'}]}))];
 const ctx=JSON.parse(buildManagementDecisionContext(x));
 assert.equal(ctx.project.approvedContract.currentMilestone.instruction,'Original approved implementation');
 assert.equal(ctx.project.milestoneIndex,0);assert.equal(ctx.evidence.find(e=>e.id==='failed').detail,'Missing development capability');
 assert.equal(ctx.recentDecisions.length,2);assert.equal(ctx.latestReplacementDecisions[0].id,'replacement');
 assert.throws(()=>buildManagementDecisionContext({...x,project:{...x.project,spec:null}}),/approved current milestone/);
 assert.throws(()=>buildManagementDecisionContext({...x,project:{...x.project,milestone_index:99}}),/approved current milestone/);
});

test('shared acceptance contracts are referenced losslessly and historical decisions do not duplicate current contracts',()=>{
 const x=fixture(),contract={path:'/game',scenarios:[{name:'Exact accepted scenario',steps:[{action:'expectText',selector:'#status',value:'X'.repeat(8000)}]}]};
 x.project={...x.project,phase:'development',milestone_index:0,spec:{milestones:[{instruction:'Approved implementation',contract}],finalContract:contract}};
 x.exceptions[0]={...x.exceptions[0],project_id:'redundant-project',resolution:null};
 x.decisions=[{id:'decision',node_id:'root',assignment_id:'job',created_at:'2026-11-14',decision:[{action:'appoint',name:'Game',area:'game',kind:'manager',tools:['manage'],objective:'Archived repeated contract '.repeat(3000)},{action:'replace_leader',nodeId:'game',reason:'Actual saved reason'}]}];
 const ctx=JSON.parse(buildManagementDecisionContext(x));
 assert.deepEqual(ctx.project.approvedContract.currentMilestone.contract,contract);
 assert.equal(ctx.project.approvedContract.finalContract.$ref,'#/project/approvedContract/currentMilestone/contract');
 assert.equal(ctx.exceptions[0].detail,x.exceptions[0].detail);assert.equal(ctx.exceptions[0].id,x.exceptions[0].id);
 assert.equal(ctx.recentDecisions[0].assignment_id,'job');assert.equal(ctx.recentDecisions[0].decision[1].reason,'Actual saved reason');
 assert.ok(!JSON.stringify(ctx).includes('Archived repeated contract'));
 assert.equal(ctx.organization[0].objective,x.scopedNodes[1].objective);
});
