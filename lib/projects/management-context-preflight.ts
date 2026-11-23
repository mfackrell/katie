import {createHash} from 'node:crypto';
import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';
import {
  completeManagementRows,
} from './organization';
import {
  buildManagementDecisionContext,managementScope,selectManagementEvidenceIds,
  type ManagementNode,type ManagementRow,type AssignmentBinding,type AssignmentStatus,
} from './management-context';

async function rowsByIds<T>(ids:string[],factory:(batch:string[])=>unknown,order:string|string[]):Promise<T[]> {
  const all:T[]=[];
  for(let i=0;i<ids.length;i+=32)
    all.push(...await completeManagementRows<T>(()=>factory(ids.slice(i,i+32)),order));
  return all;
}

export type ManagementContextPreflight={
  principalId:string;chars:number;sha256:string;inputLimit:number;
  selectedAssignments:number;unresolvedExceptions:number;organizationNodes:number;
};

// The exact production assembler, fed from its ordinary durable data sources.
// This never calls a model, reserves tokens or mutates database state.
export async function preflightManagementContext(projectId:string,principalId:string):Promise<ManagementContextPreflight>{
  const db=getSupabaseAdminClient();
  const [topology,projectRecord]=await Promise.all([
    completeManagementRows<ManagementNode>(()=>db.from('project_organization_nodes')
      .select('id,agent_id,kind,management_level,parent_id,area,depth,status,decision_needed')
      .eq('project_id',projectId),'id'),
    db.from('work_projects').select('objective,team,approved_hash,verified_sha,phase,deadline,spec,milestone_index')
      .eq('id',projectId).single(),
  ]);
  if(projectRecord.error||!projectRecord.data)throw Error('Current project contract unavailable');
  const scope=managementScope(topology,principalId);
  const project=projectRecord.data as ManagementRow&{team:string[]};
  const [focused,bindings,team,grants,plans,dependencies,owned,origin,packages,contracts,work,decisions]=await Promise.all([
    rowsByIds<ManagementNode>(scope.contextIds,ids=>db.from('project_organization_nodes').select('*').in('id',ids),'id'),
    completeManagementRows<AssignmentBinding>(()=>db.from('project_organization_assignments')
      .select('assignment_id,node_id,created_at').in('node_id',scope.decisionIds),'assignment_id'),
    rowsByIds<ManagementRow>(project.team??[],ids=>db.from('managed_agents').select('id,config').in('id',ids),'id'),
    rowsByIds<ManagementRow>(scope.contextIds,ids=>db.from('project_organization_scope_grants').select('*').in('node_id',ids),'node_id'),
    rowsByIds<ManagementRow>(scope.contextIds,ids=>db.from('project_organization_plans').select('*').in('node_id',ids),'node_id'),
    completeManagementRows<ManagementRow>(()=>db.from('project_organization_dependencies').select('*').in('node_id',scope.decisionIds),['node_id','depends_on']),
    completeManagementRows<ManagementRow>(()=>db.from('project_organization_exceptions').select('*')
      .eq('project_id',projectId).in('owner_id',scope.decisionIds),'id'),
    completeManagementRows<ManagementRow>(()=>db.from('project_organization_exceptions').select('*')
      .eq('project_id',projectId).in('origin_id',scope.decisionIds),'id'),
    completeManagementRows<ManagementRow>(()=>db.from('project_work_packages').select('*')
      .eq('project_id',projectId).in('manager_id',scope.decisionIds),'id'),
    completeManagementRows<ManagementRow>(()=>db.from('project_worker_contracts').select('*')
      .eq('project_id',projectId).in('manager_id',scope.decisionIds),'id'),
    completeManagementRows<ManagementRow>(()=>db.from('project_organization_work').select('*')
      .eq('project_id',projectId).in('node_id',scope.decisionIds),'id'),
    completeManagementRows<ManagementRow>(()=>db.from('project_organization_decisions')
      .select('id,node_id,assignment_id,decision,created_at').eq('project_id',projectId)
      .in('node_id',scope.decisionIds),'id'),
  ]);
  const statuses=await rowsByIds<AssignmentStatus>(bindings.map(b=>b.assignment_id),
    ids=>db.from('mission_assignments').select('id,status,updated_at').in('id',ids),'id');
  const chosen=selectManagementEvidenceIds(bindings,statuses,scope.decisionIds);
  const [evidence,attempts]=await Promise.all([
    rowsByIds<ManagementRow>(chosen,ids=>db.from('mission_assignments')
      .select('id,status,result,detail,mission_id,role,agent_id,instruction,payload,dependencies')
      .in('id',ids),'id'),
    rowsByIds<ManagementRow>(packages.map(p=>String(p.id)),ids=>db.from('project_work_package_attempts')
      .select('*').in('package_id',ids),['package_id','attempt']),
  ]);
  const exceptions=[...owned,...origin].filter((e,i,a)=>a.findIndex(v=>v.id===e.id)===i);
  const serialized=buildManagementDecisionContext({
    principalId,topology,scopedNodes:focused,project,executionTeam:team,
    exceptions,bindings,statuses,evidence,plans,dependencies,scopeGrants:grants,
    workerContracts:contracts,workPackages:packages,workPackageAttempts:attempts,work,decisions,
  },48000);
  return {
    principalId,chars:serialized.length,
    sha256:createHash('sha256').update(serialized).digest('hex'),
    inputLimit:48000,selectedAssignments:chosen.length,
    unresolvedExceptions:exceptions.filter(e=>e.status==='open').length,
    organizationNodes:topology.length,
  };
}
