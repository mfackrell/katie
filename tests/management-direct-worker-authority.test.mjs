import test from 'node:test';
import assert from 'node:assert/strict';
import {modules} from './helpers/load-project-modules.mjs';

const {buildManagementDecisionContext}=modules()('@/lib/projects/management-context');
const {MANAGEMENT_INSTRUCTION,assertManagementCommands}=modules()('@/lib/projects/organization');
const ROOT='c486ade1-2a9c-4cd5-a80b-90c032e4e03e';
const DELIVERY='9b62ae62-a499-490a-a7ac-6e6c5bb1229d';
const MANAGER='a00de7ce-4159-49ac-9628-a070d5dbaffd';
const ANALYST='6c585f55-aed3-43cb-903b-15f5d4fb95a2';
const QA='4e6503c8-7723-49e7-ad30-22f633feb2f8';

const node=(id,parent_id,kind,tools)=>({
 id,parent_id,kind,tools,agent_id:id,status:'active',
 management_level:kind==='worker'?'worker':id===ROOT?'project_director':'manager',
 name:'Existing organizational member '+id,area:'existing',objective:'Preserve the accepted milestone.',
 acceptance:['Verify accepted milestone'],deadline:'2026-11-26T19:45:00Z'
});
const root=node(ROOT,null,'project_director',['manage','development']);
const director=node(DELIVERY,ROOT,'manager',['manage','development','repository_review']);
const manager=node(MANAGER,DELIVERY,'manager',['manage','development','repository_review']);
const analyst=node(ANALYST,MANAGER,'worker',['analysis','repository_review']);
const qa=node(QA,ROOT,'manager',['manage','analysis','repository_review']);
const topology=[root,director,manager,analyst,qa];

function context(principalId){
 const selected=principalId===DELIVERY?[root,director,manager]:[director,manager,analyst];
 return JSON.parse(buildManagementDecisionContext({
  principalId,topology,scopedNodes:selected,
  project:{objective:'Build the originally approved tic-tac-toe milestone.',phase:'research'},
  executionTeam:[],exceptions:[],bindings:[],statuses:[],evidence:[],
  plans:[],dependencies:[],scopeGrants:[],workerContracts:[],
  workPackages:[],workPackageAttempts:[],work:[],decisions:[]
 },48000));
}
test('saved Mission92 hierarchy: Functional Director sees zero direct worker authority, never grandchild analyst',()=>{
 const directorContext=context(DELIVERY);
 assert.deepEqual(directorContext.delegationAuthority.directWorkerIds,[]);
 assert.deepEqual(directorContext.delegationAuthority.directManagerIds,[MANAGER]);
 assert.match(MANAGEMENT_INSTRUCTION,/If directWorkerIds is empty, do NOT issue assign/);
 assert.throws(()=>assertManagementCommands(director,topology,[
  {action:'assign',nodeId:ANALYST,capability:'repository_review'}
 ]),/immediate reporting authority/);
 assert.throws(()=>assertManagementCommands(director,topology,[
  {action:'commission_package',workerId:ANALYST,writerId:ANALYST,reviewerId:ANALYST}
 ]),/immediate reporting authority/);
});
test('direct Delivery Manager receives only its lawful analyst; no delegated development work is invented',()=>{
 const managerContext=context(MANAGER);
 assert.deepEqual(managerContext.delegationAuthority.directWorkerIds.map(x=>x.id),[ANALYST]);
 assert.deepEqual(managerContext.delegationAuthority.directWorkerIds[0].tools,['analysis','repository_review']);
 assertManagementCommands(manager,topology,[{action:'assign',nodeId:ANALYST,capability:'repository_review'}]);
 assert.throws(()=>assertManagementCommands(manager,topology,
  [{action:'assign',nodeId:QA,capability:'repository_review'}]),/immediate reporting authority/);
 assert.equal(topology.filter(n=>n.kind==='worker'&&n.parent_id===DELIVERY).length,0);
});


test('persisted delivery chain identifies the unused developer and sequential lawful package prerequisites',()=>{
 const {implementationCommissioningDirective}=modules()('@/lib/projects/organization');
 const paths=['app/milestone-3-tic-tac-toe/','lib/milestone-3-tic-tac-toe/','tests/milestone-3-tic-tac-toe/'];
 const scope='a'.repeat(64),project={phase:'development',approved_hash:scope,milestone_index:0};
 const d={...director,tools:['manage','analysis','development','repository_review'],management_level:'functional_director',area:'game_delivery'};
 const m={...manager,tools:['manage','analysis','development','repository_review'],area:'delivery_management',decision_needed:false};
 const supervisor=node('0e10e20e-e5a9-4443-a636-7c4866a66a5f',m.id,'manager',['manage','analysis','repository_review']);
 const scoped=[root,d,m,supervisor,analyst,qa];
 const grants=[root,d,m].map(n=>({node_id:n.id,scope_hash:scope,paths}));
 const developerId='8421786a-0874-4d86-992e-f0f087d8018e';
 const team=[{id:developerId,config:{name:'Game Development Specialist v1',development:true}}];
 const input=(principal,focused=scoped,extra={})=>({principal,topology:focused,focused,grants,team,project,milestonePackages:[],...extra});
 const handoff=implementationCommissioningDirective(input(d));
 assert.match(handoff,/IMPLEMENTATION COMMISSIONING HANDOFF/);assert.ok(handoff.includes(m.id));
 const appointment=implementationCommissioningDirective(input(m));
 assert.match(appointment,/APPOINT WORKERS/);assert.ok(appointment.includes(developerId));
 assert.match(appointment,/distinct analysis-capable technical reviewer/);
 assert.equal(implementationCommissioningDirective(input(qa)), '');
 const coder={...node('8d4f1ba7-1fa9-498c-a8ee-09b7b3750975',m.id,'worker',['analysis','development']),agent_id:developerId};
 const reviewer=node('8d4f1ba7-1fa9-498c-a8ee-09b7b3750976',m.id,'worker',['analysis']);
 const next=[...scoped,coder,reviewer];
 assert.match(implementationCommissioningDirective(input(m,next)),/GRANT CODER SCOPE/);
 const commission=implementationCommissioningDirective(input(m,next,{grants:[...grants,{node_id:coder.id,scope_hash:scope,paths}]}));
 assert.match(commission,/PACKAGE PREREQUISITES/);assert.ok(commission.includes(coder.id));assert.ok(commission.includes(reviewer.id));
 assert.match(commission,/SMART development.paths must list exact files/);
 assert.equal(implementationCommissioningDirective(input(m,next,{milestonePackages:[{id:'existing'}]})),'');
 assert.equal(implementationCommissioningDirective(input(m,scoped,{grants:[]})),'');
});


test('signed commissioning requires the persisted appointment then grant then package; prior direct targets cannot receive scope',()=>{
 const {codingCapacityManagerStage,codingCapacityStageInstruction,assertCodingCapacityManagerStage}=modules()('@/lib/projects/organization');
 const scope='a'.repeat(64),paths=['app/milestone-3-tic-tac-toe/','lib/milestone-3-tic-tac-toe/','tests/milestone-3-tic-tac-toe/'];
 const supervisor=node('0e10e20e-e5a9-4443-a636-7c4866a66a5f',MANAGER,'manager',['manage','analysis','repository_review']);
 const before=[...topology,supervisor],grants=[{node_id:MANAGER,scope_hash:scope,paths}];
 const s=codingCapacityManagerStage(manager,before,grants,scope);
 assert.equal(s.action,'appoint');assert.match(codingCapacityStageInstruction(s),/No grant_scope commands at all/);
 const app=(name,tools)=>({action:'appoint',kind:'worker',managementLevel:'worker',name,tools,paths:[]});
 const appointments=[app('Coder',['analysis','development']),app('Reviewer',['analysis'])];
 const rejects=(nodes,stage,batch)=>assert.throws(()=>assertCodingCapacityManagerStage(manager,nodes,stage,batch),e=>e.evidence?.code==='commissioning_stage');
 for(const n of [analyst,supervisor]){
  const grant={action:'grant_scope',nodeId:n.id,paths};
  assertManagementCommands(manager,before,[grant]);
  rejects(before,s,[grant]);rejects(before,s,[...appointments,grant]);
 }
 rejects(before,s,[appointments[0]]);rejects(before,s,[appointments[0],appointments[0]]);
 rejects(before,s,[...appointments,{action:'commission_package'}]);
 assert.doesNotThrow(()=>assertCodingCapacityManagerStage(manager,before,s,appointments));
 const coder=node('8d4f1ba7-1fa9-498c-a8ee-09b7b3750975',MANAGER,'worker',['analysis','development']);
 const reviewer=node('8d4f1ba7-1fa9-498c-a8ee-09b7b3750976',MANAGER,'worker',['analysis']);
 const after=[...before,coder,reviewer];
 const g=codingCapacityManagerStage(manager,after,grants,scope);assert.equal(g.action,'grant_scope');assert.equal(g.coderId,coder.id);
 for(const n of [analyst,supervisor,qa,reviewer])rejects(after,g,[{action:'grant_scope',nodeId:n.id,paths}]);
 rejects(after,g,[{action:'grant_scope',nodeId:coder.id,paths:['app/']}]);
 rejects(after,g,[{action:'grant_scope',nodeId:coder.id,paths:['app/milestone-3-tic-tac-toe/../forbidden']}]);
 assert.doesNotThrow(()=>assertCodingCapacityManagerStage(manager,after,g,[{action:'grant_scope',nodeId:coder.id,paths}]));
 const ready=codingCapacityManagerStage(manager,after,[...grants,{node_id:coder.id,scope_hash:scope,paths}],scope);
 assert.equal(ready.action,'commission_package');
 const command={action:'commission_package',workerId:coder.id,writerId:coder.id,reviewerId:reviewer.id};
 rejects(after,ready,[{action:'grant_scope',nodeId:coder.id,paths}]);
 rejects(after,ready,[command,command]);rejects(after,ready,[{...command,reviewerId:coder.id}]);
 assert.doesNotThrow(()=>assertCodingCapacityManagerStage(manager,after,ready,[command]));
});


test('Mission99 signed appointment eligibility uses actual original roster, excludes assigned/archived identities, and validates permissions before SQL',()=>{
 const {eligibleCommissioningAgents,requireCommissioningAgentPair,commissioningAgentInstruction,assertCommissioningWorkerIdentities}=modules()('@/lib/projects/organization');
 const conflict='0c491807-490a-4bfb-a56b-115d4dece4bf',coder='8421786a-0874-4d86-992e-f0f087d8018e',reviewer='e7d25ada-a761-41bf-8f65-f87056f175fa';
 const roster=topology.map(n=>n.id===ANALYST?{...n,agent_id:conflict}:n);
 const registry=[{id:conflict,archived:false,config:{name:'Project Research',development:false,research:true,reviewMode:'always'}},
  {id:coder,archived:false,config:{name:'Game Development Specialist v1',development:true,research:true,reviewMode:'always'}},
  {id:reviewer,archived:false,config:{name:'Project Lead',development:false,research:false,reviewMode:'always'}}];
 const eligible=eligibleCommissioningAgents(roster,registry);
 assert.deepEqual(eligible.map(x=>x.id),[coder,reviewer]);
 assert.doesNotThrow(()=>requireCommissioningAgentPair(eligible));
 assert.match(commissioningAgentInstruction(eligible),new RegExp(coder));
 assert.match(commissioningAgentInstruction(eligible),new RegExp(reviewer));
 assert.doesNotMatch(commissioningAgentInstruction(eligible),new RegExp(conflict));
 const good=[{action:'appoint',kind:'worker',reuseAgentId:coder,tools:['analysis','development']},
  {action:'appoint',kind:'worker',reuseAgentId:reviewer,tools:['analysis']}];
 assert.doesNotThrow(()=>assertCommissioningWorkerIdentities(roster,eligible,good));
 const invalid=[good.map((c,i)=>i?{...c,reuseAgentId:conflict}:c),
  [good[0],{...good[1],reuseAgentId:coder.toUpperCase()}],
  [{...good[0],reuseAgentId:reviewer},good[1]],
  [good[0],{...good[1],reuseAgentId:undefined}],
  [good[0],{...good[1],reuseAgentId:QA}],
  [good[0],{...good[1],parentId:QA}],
  [good[0],{...good[1],tools:['analysis','research']}]];
 for(const batch of invalid)assert.throws(()=>assertCommissioningWorkerIdentities(roster,eligible,batch),e=>e.evidence?.code==='commissioning_agent_identity');
 const blocked=roster.map(n=>n.id===ANALYST?{...n,status:'blocked'}:n);
 assert.deepEqual(eligibleCommissioningAgents(blocked,registry).map(a=>a.id),[coder,reviewer]);
 const archived=registry.map(a=>a.id===reviewer?{...a,archived:true}:a);
 assert.throws(()=>requireCommissioningAgentPair(eligibleCommissioningAgents(roster,archived)),/resource constraint/);
 const noDev=registry.map(a=>a.id===coder?{...a,config:{...a.config,development:false}}:a);
 assert.throws(()=>requireCommissioningAgentPair(eligibleCommissioningAgents(roster,noDev)),/resource constraint/);
});


test('Mission102 exact committed package identities exclude the prior analyst and supervisor; reviewer has no write or repository authority',()=>{
 const {codingCapacityManagerStage,committedCommissioningPackageRoles,commissioningPackageRoleInstruction,assertCommissioningPackageRoles}=modules()('@/lib/projects/organization');
 const scope='a'.repeat(64),paths=['app/milestone-3-tic-tac-toe/','lib/milestone-3-tic-tac-toe/','tests/milestone-3-tic-tac-toe/'];
 const coderId='08e792df-1046-4282-89dc-83994a8a6b7e',reviewerId='1cf12044-d9ba-4e8b-9ef4-8b7e5aa004a5';
 const coder={...node(coderId,MANAGER,'worker',['development','analysis']),scope_hash:scope,name:'Game Development Specialist v1',area:'tic_tac_toe_implementation',agent_id:'8421786a-0874-4d86-992e-f0f087d8018e'};
 const reviewer={...node(reviewerId,MANAGER,'worker',['analysis']),scope_hash:scope,name:'Project Lead',area:'tic_tac_toe_technical_review',agent_id:'e7d25ada-a761-41bf-8f65-f87056f175fa'};
 const supervisor=node('0e10e20e-e5a9-4443-a636-7c4866a66a5f',MANAGER,'manager',['manage','analysis','repository_review']);
 const after=[...topology,supervisor,coder,reviewer];
 const grants=[{node_id:MANAGER,scope_hash:scope,paths},{node_id:coderId,parent_id:MANAGER,scope_hash:scope,paths}];
 const team=[{id:coder.agent_id,archived:false,config:{development:true}},{id:reviewer.agent_id,archived:false,config:{development:false}}];
 const appointment=n=>({action:'appoint',kind:'worker',name:n.name,area:n.area,tools:n.tools,reuseAgentId:n.agent_id});
 const d={node_id:MANAGER,assignment_id:'1e6d47e0-1515-4cd7-997a-47148d6d52f4',decision:[appointment(coder),appointment(reviewer),{action:'ready'}]};
 const statuses=[{id:d.assignment_id,status:'completed'}];
 const stage=codingCapacityManagerStage(manager,after,grants,scope);
 const roles=committedCommissioningPackageRoles(manager,after,team,[d],statuses,grants,scope,stage,0);
 assert.deepEqual(JSON.parse(JSON.stringify(roles)),{workerId:coderId,writerId:coderId,reviewerId,milestoneIndex:0,paths});
 assert.match(commissioningPackageRoleInstruction(roles),new RegExp(reviewerId));
 assert.match(commissioningPackageRoleInstruction(roles),/tasks.review.paths must be \[\]/);
 const valid={action:'commission_package',...roles,tasks:{development:{paths:[paths[0]+'page.tsx']},compose:{paths:[]},review:{paths:[]}}};
 assert.doesNotThrow(()=>assertCommissioningPackageRoles(manager,after,roles,stage,[valid]));
 let rejected=0;
 for(const writerId of [coderId,reviewerId,ANALYST,supervisor.id])for(const proposedReviewerId of [coderId,reviewerId,ANALYST,supervisor.id]){
  if(writerId===coderId&&proposedReviewerId===reviewerId)continue;
  assert.throws(()=>assertCommissioningPackageRoles(manager,after,roles,stage,[{...valid,writerId,reviewerId:proposedReviewerId}]),e=>e.evidence?.code==='commissioning_package_roles');rejected++;
 }
 assert.equal(rejected,15);
 for(const change of [{workerId:ANALYST},{reviewerId:QA},{writerId:QA},{milestoneIndex:1},{milestoneIndex:undefined},{milestoneIndex:-1},{paths:['app/']},
  {tasks:{...valid.tasks,development:{paths:[paths[0]]}}},{tasks:{...valid.tasks,development:{paths:[paths[0]+'../other.ts']}}},{tasks:{...valid.tasks,review:{paths:[paths[0]+'page.tsx']}}}]){
  assert.throws(()=>assertCommissioningPackageRoles(manager,after,roles,stage,[{...valid,...change}]),e=>e.evidence?.code==='commissioning_package_roles');
 }
 assert.throws(()=>committedCommissioningPackageRoles(manager,after,team,[],statuses,grants,scope,stage,0));
 assert.throws(()=>committedCommissioningPackageRoles(manager,after,team,[d],[{id:d.assignment_id,status:'failed'}],grants,scope,stage,0));
 assert.throws(()=>committedCommissioningPackageRoles(manager,after,team.map(a=>({...a,archived:true})),[d],statuses,grants,scope,stage,0));
 assert.throws(()=>committedCommissioningPackageRoles(manager,after.map(n=>n.id===coderId?{...n,tools:['analysis']}:n),team,[d],statuses,grants,scope,stage,0));
});
