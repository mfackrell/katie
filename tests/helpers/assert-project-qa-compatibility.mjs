import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

// Full installed migration stack; only technical outputs are synthetic. All
// appointments, scheduling, component attestations and closure use actual RPCs.
export async function assertProjectQaCompatibility(db){
 for(const qaArea of ['quality_assurance','independent_qa']){
  await db.query('reset role');await db.query('begin');
  try{
   const actor=randomUUID(),chat=randomUUID(),owner=randomUUID(),project=randomUUID();
   await db.query("insert into actors(id,name,actor_kind) values($1,'G6 fixture owner','standard')",[actor]);
   await db.query("insert into chats(id,actor_id,title) values($1,$2,'Isolated G6 QA fixture')",[chat,actor]);
   await db.query('select standalone_bind_scope($1,$2,$3)',[owner,actor,chat]);
   await db.query('set role service_role');
   const p=(await db.query('select create_work_project($1,$2,$3,$4,$5,null) p',[project,'g6-'+project,actor,chat,'Deliver an independently verified fixture component'])).rows[0].p;
   const hash=(await db.query("select encode(sha256(convert_to(objective||clarifications,'UTF8')),'hex') h from work_projects where id=$1",[project])).rows[0].h;
   await db.query('select project_org_authorize($1,$2,$3,1000000,100000,true)',[owner,project,hash]);
   const nodes=async()=>(await db.query('select * from project_organization_nodes where project_id=$1 order by id',[project])).rows;
   const root=(await nodes())[0],deadline=new Date(Date.parse(p.deadline)-1000).toISOString();
   const session=async id=>{
    const lease=randomUUID();await db.query('reset role');
    await db.query('update project_organization_nodes set decision_needed=(id=$2) where project_id=$1',[project,id]);
    await db.query("update work_projects set lease=$2,lease_until=clock_timestamp()+interval '5 minutes' where id=$1",[project,lease]);
    await db.query('set role service_role');
    const s=(await db.query('select project_org_schedule($1,$2) s',[project,lease])).rows[0].s;
    assert.equal(s.nodeId,id,JSON.stringify(s));assert.ok(s.missionId);
    await db.query('reset role');
    const job=(await db.query("update mission_assignments set status='running',lease=$2,lease_until=clock_timestamp()+interval '5 minutes' where mission_id=$1 and status='queued' returning id",[s.missionId,randomUUID()])).rows[0];
    assert.ok(job);await db.query('set role service_role');
    return (await db.query('select id,lease from mission_assignments where id=$1',[job.id])).rows[0];
   };
   const decide=(s,commands)=>db.query('select project_org_decide($1,$2,$3)',[s.id,s.lease,JSON.stringify(commands)]);
   const negative=async(label,mutate,action,pattern)=>{
    await db.query('savepoint g6_negative');
    try{
     if(mutate){await db.query('reset role');await mutate();await db.query('set role service_role');}
     await assert.rejects(action,pattern,label);
    }finally{await db.query('rollback to savepoint g6_negative');await db.query('release savepoint g6_negative');await db.query('set role service_role');}
   };
   const appoint=(name,area,tools,kind='manager')=>({action:'appoint',kind,name,area,objective:'Verify '+name,acceptance:['Verified '+name],tokens:kind==='manager'?100000:10000,deadline,tools,paths:[]});
   const leadership=['manage','analysis','repository_review'];
   let s=await session(root.id);
   await negative('QA appointment cannot acquire development',null,()=>decide(s,[appoint('Forbidden QA',qaArea,[...leadership,'development'])]),/Independent QA cannot inherit implementation authority/);
   await decide(s,[{action:'plan',purpose:'Deliver verified component',direction:'Preserve independent verification and scope',outcomes:[{criterion:'Original objective satisfied',verification:'Independent source-bound review'}],milestones:[{objective:'One verified component'}],organizations:['development',qaArea]},
    appoint('Delivery','development',[...leadership,'development']),appoint('QA',qaArea,leadership),{action:'ready'}]);
   const qa=(await nodes()).find(n=>n.area===qaArea),dev=(await nodes()).find(n=>n.area==='development');
   assert.equal((await nodes()).filter(n=>n.area===qaArea).length,1);
   await negative('QA identity cannot be renamed',null,async()=>{
    await db.query('reset role');
    await db.query("update project_organization_nodes set area='ordinary_review' where id=$1",[qa.id]);
   },/Organizational identity and delegated authority are immutable/);
   s=await session(root.id);
   await negative('Existing amendment fix remains intact',null,()=>decide(s,[{action:'amend_delegation',nodeId:qa.id,expectedTools:qa.tools,tools:[...qa.tools,'development'],expectedDeadline:deadline,reason:'Forbidden QA development authority'}]),/Independent QA cannot inherit implementation authority/);
   await decide(s,[{action:'ready'}]);

   // Model an already-existing unsafe legacy QA branch, without changing any
   // real node. A neutral-area grandchild must still inherit the QA fence.
   await db.query('savepoint legacy_qa_ancestry');await db.query('reset role');
   const seedManager=async(parent,area,depth)=>{
    const a=(await db.query('select save_managed_agent(null,$1,false) a',[{name:'Synthetic legacy QA manager',instructions:'Fixture only',research:false,development:false,attachments:false,reviewMode:'always',maxActiveTasks:1,maxInputChars:16000}])).rows[0].a.id;
    return (await db.query("insert into project_organization_nodes(project_id,parent_id,agent_id,kind,area,name,objective,acceptance,tools,token_limit,deadline,depth,management_level) values($1,$2,$3,'manager',$4,'Legacy QA fixture','Fixture only','[\"Verified fixture\"]',$5,100000,$6,$7,$8) returning id",[project,parent,a,area,[...leadership,'development'],deadline,depth,depth===1?'functional_director':'manager'])).rows[0].id;
   };
   const legacyQa=await seedManager(root.id,qaArea,1),descendant=await seedManager(legacyQa,'qa_subteam',2);
   s=await session(descendant);
   await negative('QA ancestry survives a neutral child designation',null,()=>decide(s,[appoint('Forbidden coder','ordinary_execution',['analysis','development'],'worker')]),/Independent QA cannot inherit implementation authority/);
   await db.query('rollback to savepoint legacy_qa_ancestry');await db.query('release savepoint legacy_qa_ancestry');await db.query('set role service_role');
   assert.equal((await nodes()).filter(n=>n.area===qaArea).length,1,'temporary legacy fixture leaves no duplicate QA organization');

   s=await session(qa.id);
   await negative('Safe QA cannot delegate development',null,()=>decide(s,[appoint('Forbidden QA coder','neutral',['analysis','development'],'worker')]),/Child authority exceeds parent|Independent QA/);
   await decide(s,[appoint('Reviewer','review',['analysis'],'worker'),{action:'ready'}]);
   s=await session(dev.id);
   await decide(s,[appoint('Author','implementation',['analysis','development'],'worker'),{action:'ready'}]);
   const reviewer=(await nodes()).find(n=>n.name==='Reviewer'),author=(await nodes()).find(n=>n.name==='Author');
   const scope='a'.repeat(64),head='b'.repeat(40),assessment=randomUUID();
   const contract={scenarios:[{name:'Fixture acceptance',steps:[]}]};
   const preview={headSha:head,immutable:true,browserAcceptance:{passed:true,headSha:head}};
   await db.query('reset role');
   await db.query("update work_projects set spec=$2,approved_hash=$3,approval_hash=$3,verified_sha=$4,phase='assessment',preview=$5 where id=$1",[project,{allowedPaths:['src/'],finalContract:contract},scope,head,preview]);
   await db.query('select create_mission($1,$2,$3,20,null)',[assessment,'Synthetic completed independent assessment',[author.agent_id,reviewer.agent_id]]);
   await db.query("update agent_missions set project_id=$2,project_kind='assessment',project_evidence=$3 where id=$1",[assessment,project,{approvedScopeHash:scope,approvedFinalContract:contract,preview}]);
   const checks=['requirement:assigned-outcome','criterion:1','criterion:2','overall-objective','factual-support','prior-findings'].map(id=>({id,passed:true}));
   const writer=(await db.query("update mission_assignments set role='compose',status='completed',result=$3 where mission_id=$1 and agent_id=$2 returning id",[assessment,author.agent_id,{text:'Synthetic independently reviewable component'}])).rows[0].id;
   const review=randomUUID();
   await db.query("insert into mission_assignments(id,mission_id,agent_id,job_key,role,instruction,status,result) values($1,$2,$3,'independent-final-qa','review','Evaluate original requirements','completed',$4)",[review,assessment,reviewer.agent_id,{verdict:'pass',checks}]);
   await db.query("update agent_missions set status='completed',result='Synthetic completed assessment' where id=$1",[assessment]);
   await db.query('update work_projects set active_mission_id=$2 where id=$1',[project,assessment]);
   const certify=(node,assignmentId,action='certify')=>({action,...(action==='certify'?{nodeId:node.id}:{}),assignmentId,checks:node.acceptance.map(criterion=>({criterion,passed:true,assignmentId,evaluation:'Checked synthetic source output against the original delegated criterion'}))});
   for(const [manager,worker,job]of [[qa,reviewer,review],[dev,author,writer]]){
    s=await session(manager.id);
    await decide(s,[certify(worker,job),certify(manager,job,'submit_component')]);
   }
   s=await session(root.id);
   await negative('Closure before component acceptance is prohibited',null,()=>decide(s,[{action:'close'}]),/Organizations or exceptions remain incomplete/);
   await negative('Root cannot certify missing director evidence',()=>db.query('update project_organization_nodes set completion_submission=null where id=$1',[qa.id]),()=>decide(s,[certify(qa,review)]),/responsible director component submission/);
   await decide(s,[certify(qa,review),certify(dev,writer)]);
   s=await session(root.id);
   const close=()=>decide(s,[{action:'close'}]);
   await negative('Wrong management lease',null,()=>decide({...s,lease:randomUUID()},[{action:'close'}]),/Live management assignment/);
   const negatives=[
    ['unaccepted QA',"update project_organization_nodes set status='active' where id=$1",[qa.id],/Organizations or exceptions/],
    ['open exception',"insert into project_organization_exceptions(project_id,origin_id,owner_id,reason,detail) values($1,$2,$2,'routine','Unresolved fixture finding')",[project,qa.id],/Organizations or exceptions/],
    ['unapproved scope',"update work_projects set approval_hash=repeat('c',64) where id=$1",[project],/Only the Project Director/],
    ['stale QA head',"update project_organization_nodes set evidence=jsonb_set(evidence,'{head}',to_jsonb(repeat('c',40))) where id=$1",[qa.id],/Independent original-requirement/],
    ['stale QA scope',"update project_organization_nodes set evidence=jsonb_set(evidence,'{scopeHash}',to_jsonb(repeat('c',64))) where id=$1",[qa.id],/Independent original-requirement/],
    ['foreign QA evidence',"update project_organization_nodes set evidence=jsonb_set(evidence,'{assignmentId}',to_jsonb($2::text)) where id=$1",[qa.id,writer],/Independent original-requirement/],
    ['review outside QA reporting subtree',"update project_organization_assignments set node_id=$2 where assignment_id=$1",[review,author.id],/Independent original-requirement/],
    ['stale assessment scope',"update agent_missions set project_evidence=jsonb_set(project_evidence,'{approvedScopeHash}',to_jsonb(repeat('c',64))) where id=$1",[assessment],/Independent original-requirement/],
    ['changed final contract',"update agent_missions set project_evidence=jsonb_set(project_evidence,'{approvedFinalContract}','{}') where id=$1",[assessment],/Independent original-requirement/],
    ['changed preview',"update agent_missions set project_evidence=jsonb_set(project_evidence,'{preview}','{}') where id=$1",[assessment],/Independent original-requirement/],
    ['failed QA criterion',"update mission_assignments set result=jsonb_set(result,'{checks,0,passed}','false') where id=$1",[review],/Independent original-requirement/],
    ['missing QA criterion',"update mission_assignments set result=jsonb_set(result,'{checks}',(result->'checks')-0) where id=$1",[review],/Independent original-requirement/],
    ['failed verdict',"update mission_assignments set result=jsonb_set(result,'{verdict}','\"fail\"') where id=$1",[review],/Independent original-requirement/],
    ['incomplete assessment',"update agent_missions set status='running' where id=$1",[assessment],/Independent original-requirement/],
    ['incomplete author',"update mission_assignments set status='failed' where id=$1",[writer],/Organizations or exceptions remain incomplete/],
    ['same author and reviewer',"update mission_assignments set agent_id=$2 where id=$1",[writer,reviewer.agent_id],/Organizations or exceptions remain incomplete/],
   ];
   for(const [label,sql,args,pattern]of negatives)await negative(label,()=>db.query(sql,args),close,pattern);
   const before=(await nodes()).map(n=>({id:n.id,area:n.area,parent_id:n.parent_id}));
   await close();
   const closure=(await db.query('select * from project_organization_closures where project_id=$1',[project])).rows[0];
   assert.equal(closure.director_id,root.id);assert.equal(closure.scope_hash,scope);assert.equal(closure.head_sha,head);assert.equal(closure.receipt.assessmentMissionId,assessment);
   assert.deepEqual((await nodes()).map(n=>({id:n.id,area:n.area,parent_id:n.parent_id})),before,'closure preserves every existing identity and reporting relationship');
   console.log('G6_QA_COMPATIBILITY_PASS '+qaArea+': appointment/amendment/ancestry isolation; real director attestations; 19 closure negatives; valid source-bound closure; identities preserved');
  }finally{await db.query('rollback');await db.query('reset role');}
 }
 await db.query('set role service_role');
}
