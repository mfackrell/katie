// Read-only, decision-scoped projection of the durable management ledger.
// The PostgreSQL source tables remain the authority: this view is never an approval.
export type ManagementRow=Record<string,unknown>;
export type ManagementNode=ManagementRow&{
 id:string;agent_id?:string;parent_id?:string|null;kind:string;
 management_level?:string;area?:string;status?:string;depth?:number;
};
export type AssignmentBinding={assignment_id:string;node_id:string;created_at?:string};
export type AssignmentStatus={id:string;status:string;updated_at?:string};
type Inputs={
 principalId:string;
 topology:ManagementNode[];
 scopedNodes:ManagementNode[];
 project:ManagementRow;
 executionTeam:ManagementRow[];
 exceptions:ManagementRow[];
 bindings:AssignmentBinding[];
 statuses:AssignmentStatus[];
 evidence:ManagementRow[];
 plans:ManagementRow[];
 dependencies:ManagementRow[];
 scopeGrants:ManagementRow[];
 workerContracts:ManagementRow[];
 workPackages:ManagementRow[];
 workPackageAttempts:ManagementRow[];
 work:ManagementRow[];
};

function required(condition:unknown,reason:string):asserts condition{
 if(!condition)throw Error('Required management evidence unavailable: '+reason);
}
function sortedLatest<T extends ManagementRow>(rows:T[]):T[]{
 return [...rows].sort((a,b)=>String(b.created_at??b.updated_at??'').localeCompare(String(a.created_at??a.updated_at??''))||String(b.id??b.assignment_id??'').localeCompare(String(a.id??a.assignment_id??'')));
}
export function managementScope(topology:ManagementNode[],principalId:string){
 required(topology.length>0,'missing organization topology');
 const byId=new Map(topology.map(n=>[n.id,n]));
 required(byId.size===topology.length,'duplicate organization identity');
 const principal=byId.get(principalId);
 required(principal&&principal.kind!=='worker','missing management principal');
 const ancestorIds:string[]=[];
 const seen=new Set([principalId]);
 let parentId=principal.parent_id;
 while(parentId){
  required(!seen.has(parentId),'reporting cycle');
  seen.add(parentId);
  required(byId.has(parentId),'missing reporting ancestor');
  ancestorIds.push(parentId);
  parentId=byId.get(parentId)?.parent_id;
 }
 const direct=topology.filter(n=>n.parent_id===principalId);
 const contextIds=[principalId,...(principal.parent_id?[principal.parent_id]:[]),...direct.map(n=>n.id)];
 return {principal,directIds:direct.map(n=>n.id),ancestorIds,contextIds,decisionIds:[principalId,...direct.map(n=>n.id)]};
}

// Always load status for every binding before selecting a small set of full results.
// Pending assignments and the latest outcome of each immediate report are mandatory.
// Older completed/failed attempts stay in PostgreSQL and do not grow the prompt.
export function selectManagementEvidenceIds(bindings:AssignmentBinding[],statuses:AssignmentStatus[],decisionIds:string[]){
 const byStatus=new Map(statuses.map(s=>[s.id,s]));
 required(byStatus.size===statuses.length,'duplicate assignment status');
 for(const b of bindings)required(byStatus.has(b.assignment_id),'unreadable assignment status '+b.assignment_id);
 const selected=new Set<string>();
 const terminal=new Set(['completed','failed','blocked','stopped','cancelled','canceled']);
 for(const id of decisionIds){
  const history=[...bindings].filter(b=>b.node_id===id).sort((a,b)=>
   String(b.created_at??'').localeCompare(String(a.created_at??''))||
   b.assignment_id.localeCompare(a.assignment_id));
  for(const b of history){
   const status=byStatus.get(b.assignment_id)?.status;
   required(typeof status==='string'&&status.length>0,'missing assignment status');
   if(!terminal.has(status))selected.add(b.assignment_id);
  }
  const latestComplete=history.find(b=>byStatus.get(b.assignment_id)?.status==='completed');
  const latestFailure=history.find(b=>['failed','blocked','stopped'].includes(byStatus.get(b.assignment_id)?.status??''));
  // Completed management decisions are already in the durable decision ledger.
  // A manager sees its own unresolved failure, not its entire past transcript.
  if(id!==decisionIds[0]&&latestComplete)selected.add(latestComplete.assignment_id);
  if(latestFailure&&(!latestComplete||String(latestFailure.created_at??'')>String(latestComplete.created_at??'')))
   selected.add(latestFailure.assignment_id);
 }
 return [...selected].sort();
}
export function buildManagementDecisionContext(input:Inputs,limit=48000):string{
 const {principalId,topology,scopedNodes,project}=input;
 const scope=managementScope(topology,principalId);
 const scoped=new Map(scopedNodes.map(n=>[n.id,n]));
 required(scoped.size===scopedNodes.length,'duplicate scoped contract');
 for(const id of scope.contextIds)required(scoped.has(id),'missing immediate management contract '+id);
 const principal=scoped.get(principalId)!;
 required(typeof project?.objective==='string'&&project.objective.length>0,'original owner objective');
 required(principal.agent_id===scope.principal.agent_id,'principal agent identity mismatch');
 const relevant=new Set(scope.decisionIds);
 const chosenIds=selectManagementEvidenceIds(input.bindings,input.statuses,scope.decisionIds);
 const chosen=new Set(chosenIds);
 const evidenceById=new Map(input.evidence.map(e=>[String(e.id),e]));
 required(evidenceById.size===input.evidence.length,'duplicate selected evidence');
 for(const id of chosenIds){
  required(evidenceById.has(id),'selected assignment evidence '+id);
  required(evidenceById.get(id)?.status===input.statuses.find(s=>s.id===id)?.status,'assignment status changed while assembling evidence '+id);
 }
 const statusMap=new Map(input.statuses.map(s=>[s.id,s.status]));
 const counts=scope.decisionIds.map(nodeId=>{
  const rows=input.bindings.filter(b=>b.node_id===nodeId);
  return {nodeId,total:rows.length,completed:rows.filter(b=>statusMap.get(b.assignment_id)==='completed').length,
   failed:rows.filter(b=>['failed','blocked','stopped'].includes(statusMap.get(b.assignment_id)??'')).length,
   inProgress:rows.filter(b=>!['completed','failed','blocked','stopped','cancelled','canceled'].includes(statusMap.get(b.assignment_id)??'')).length};
 });
 const immediate=scope.directIds.map(id=>scoped.get(id)!);
 const exceptions=input.exceptions.filter(e=>e.status!=='resolved'&&e.status!=='closed'&&
  (relevant.has(String(e.owner_id))||relevant.has(String(e.origin_id))));
 const externalDependencies=input.dependencies.filter(d=>!scope.contextIds.includes(String(d.depends_on)))
  .map(d=>{const node=topology.find(n=>n.id===d.depends_on);
   required(node,'unknown dependency target '+String(d.depends_on));
   return {id:node.id,kind:node.kind,area:node.area,status:node.status,parentId:node.parent_id};});
 const retiredPackages=new Set(['accepted','cancelled','canceled','closed']);
 const activePackages=input.workPackages.filter(p=>!retiredPackages.has(String(p.status)));
 const acceptedPackages=input.workPackages.filter(p=>p.status==='accepted');
 const activePackageIds=new Set(activePackages.map(p=>String(p.id)));
 // Attempt rows have a numeric ordinal but no created_at, updated_at or id.
 // Date/ID ordering would silently choose attempt 1 instead of the latest retry.
 const packageAttempts=input.workPackageAttempts.filter(a=>activePackageIds.has(String(a.package_id)));
 const attemptKeys=new Set<string>();
 for(const a of packageAttempts){
  required(Number.isSafeInteger(a.attempt)&&Number(a.attempt)>0,'invalid package attempt ordinal');
  const key=String(a.package_id)+':'+String(a.attempt);
  required(!attemptKeys.has(key),'duplicate package attempt ordinal');
  attemptKeys.add(key);
 }
 const attempts=[...packageAttempts]
  .sort((a,b)=>String(a.package_id).localeCompare(String(b.package_id))||Number(b.attempt)-Number(a.attempt))
  .filter((a,i,all)=>all.findIndex(x=>x.package_id===a.package_id)===i);
 const currentWork=input.work.filter(w=>!['completed','accepted','cancelled','canceled','closed'].includes(String(w.status)));
 const activeWorkIds=new Set(currentWork.map(w=>String(w.id)));
 const currentContracts=sortedLatest(input.workerContracts.filter(c=>
   (!c.package_id&&!c.work_id)||activePackageIds.has(String(c.package_id))||activeWorkIds.has(String(c.work_id))))
  .filter((c,i,all)=>all.findIndex(x=>x.worker_id===c.worker_id&&x.role===c.role&&x.package_id===c.package_id&&x.work_id===c.work_id)===i);
 const directLineage=scope.ancestorIds.map(id=>{const n=topology.find(x=>x.id===id)!;
  return {id:n.id,kind:n.kind,area:n.area,status:n.status,parentId:n.parent_id};});
 // Parent historical submissions and project roster IDs are not authority or
 // decision evidence for this manager. Keep the exact current parent contract.
 const parent=scope.principal.parent_id?scoped.get(scope.principal.parent_id):null;
 const immediateSuperior=parent?{
  id:parent.id,parent_id:parent.parent_id,kind:parent.kind,management_level:parent.management_level,
  area:parent.area,name:parent.name,objective:parent.objective,acceptance:parent.acceptance,
  tools:parent.tools,scope_paths:parent.scope_paths,scope_hash:parent.scope_hash,
  token_limit:parent.token_limit,deadline:parent.deadline,status:parent.status,
  management_contract:parent.management_contract,
 }:null;
 const currentProject={objective:project.objective,phase:project.phase,approved_hash:project.approved_hash,
  verified_sha:project.verified_sha,deadline:project.deadline};
 const payload={
  project:currentProject,principal,
  reporting:{immediateSuperior,
   ancestors:directLineage,directReportIds:scope.directIds,organizationNodeCount:topology.length},
  organization:immediate,
  executionTeam:input.executionTeam.map(a=>({id:a.id,
   name:(a.config as ManagementRow|null)?.name,
   research:(a.config as ManagementRow|null)?.research,
   development:(a.config as ManagementRow|null)?.development,
   reviewMode:(a.config as ManagementRow|null)?.reviewMode})),
  plans:input.plans,dependencies:input.dependencies,externalDependencyStatuses:externalDependencies,
  scopeGrants:input.scopeGrants,exceptions,
  workerContracts:currentContracts,workPackages:activePackages,
  acceptedPackageCount:acceptedPackages.length,workPackageAttempts:attempts,work:currentWork,
  assignments:input.bindings.filter(b=>chosen.has(b.assignment_id)),
  evidence:chosenIds.map(id=>evidenceById.get(id)),
  historyReferences:{source:'PostgreSQL immutable assignment/decision and provider ledgers',
   byNode:counts,selectedAssignmentIds:chosenIds,
   omittedHistoricalAssignments:input.bindings.length-chosenIds.length,
   archivedWorkerContracts:input.workerContracts.length-currentContracts.length,
   archivedPackageAttempts:input.workPackageAttempts.length-attempts.length,
   retiredPackageCount:input.workPackages.length-activePackages.length}
 };
 const serialized=JSON.stringify(payload);
 required(Number.isSafeInteger(limit)&&limit>0,'configured management input limit');
 if(serialized.length>limit)throw Error('Required management decision evidence exceeds bounded context; do not omit current contracts, unresolved exceptions, or necessary assignment results.');
 return serialized;
}
