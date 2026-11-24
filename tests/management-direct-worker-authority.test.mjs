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
