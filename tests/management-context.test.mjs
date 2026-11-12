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
 const root=node('root',null,'project_director'),a=node('a','root'),b=node('b','a'),c=node('c','b'),worker=node('worker','c','worker');
 const x=fixture();x.principalId='c';x.topology=[root,a,b,c,worker];x.scopedNodes=[b,c,worker];
 x.bindings=[];x.statuses=[];x.evidence=[];x.dependencies=[];x.exceptions=[];x.plans=[];
 const ctx=JSON.parse(buildManagementDecisionContext(x));
 assert.equal(ctx.principal.id,'c');
 assert.equal(ctx.reporting.immediateSuperior.id,'b');
 assert.deepEqual(ctx.reporting.ancestors.map(n=>n.id),['b','a','root']);
 assert.deepEqual(ctx.reporting.directReportIds,['worker']);
 assert.deepEqual(ctx.organization.map(n=>n.id),['worker']);
 assert.ok(!ctx.organization.some(n=>n.id==='a'||n.id==='root'));
});
test('unresolved owned exceptions, external dependency statuses and current activity cannot silently disappear',()=>{
 const x=fixture();
 x.exceptions.push({id:'unrelated',origin_id:'qa-deep',owner_id:'someone-else',status:'open',detail:'Not this reporting chain'});
 x.dependencies.push({node_id:'game',depends_on:'external'});
 x.topology.push(node('external','root','manager',{status:'blocked'}));
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
 assert.deepEqual(selectManagementEvidenceIds(bs,states,['root','child']),['three','two','five'].sort());
 assert.throws(()=>selectManagementEvidenceIds(bs,states.slice(1),['root','child']),/unreadable assignment status/);
});
