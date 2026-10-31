import {assessLifecycleCapacity,STAGES} from './lifecycle-capacity.mjs';
// Every operation is SELECT or an existing STABLE accounting RPC. No grants,
// reservations, phase transitions, approval proposals, or provider requests.
const number=v=>v!==null&&v!==undefined&&v!==''&&Number.isSafeInteger(Number(v))&&Number(v)>=0?Number(v):null;
const numericString=v=>typeof v==='string'?v:typeof v==='number'&&Number.isSafeInteger(v)?String(v):null;
const stamp=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))?Date.parse(v):null;
const sum=rows=>rows.every(v=>number(v)!==null)&&Number.isSafeInteger(rows.reduce((a,v)=>a+Number(v),0))?rows.reduce((a,v)=>a+Number(v),0):null;
const canonical=value=>JSON.stringify(value,(_k,v)=>Array.isArray(v)&&v.every(x=>x&&typeof x.id==='string')?[...v].sort((a,b)=>a.id.localeCompare(b.id)):v);
export function capacityProgress({binding,recovery,phase='implementation',completedStages=[],notRequiredStages=[]}){
 const key={'review':'initial_review','final-review':'final_review'}[phase]??phase;
 const restored=recovery?.phase==='repair'?['implementation','initial_review']:[];
 return {source:recovery?'authenticated_recovery':'trusted_host',binding,phase:key,completedStages:[...new Set([...restored,...completedStages])],notRequiredStages,checkpointSha:recovery?.checkpointSha??null};
}
export async function readNativeLifecycleCapacity({db,task,project,approval,continuation,context,recovery,phase,completedStages=[],notRequiredStages=[],grantId=null,observations=[],now=Date.now()}){
 const binding={taskId:task.id,projectId:project.id,baselineSha:context.baselineSha,scopeHash:project.approved_hash,contractHash:context.contractHash};
 const progress=capacityProgress({binding,recovery,phase:phase??recovery?.phase??'implementation',completedStages,notRequiredStages});
 const input={binding,progress,observedAt:now,cohort:project.approved_hash,work:{repairIterations:progress.completedStages.includes('repair')||progress.notRequiredStages.includes('repair')?0:1,additionalRepairIterations:0},observations:[],authorization:{},pricing:{},
  // Native tools are isolated from paid external APIs. Deployment charges are
  // not assumed free; their absence remains explicit rather than invented.
  otherApiCostMicrousd:Object.fromEntries(Object.keys(STAGES).map(k=>[k,k==='browser_delivery'?null:'0']))};
 try{
  const get=async query=>{const {data,error}=await query.abortSignal(AbortSignal.timeout(2500));if(error||data===null)throw Error('snapshot_unavailable');return data;};
  const one=(table,id)=>get(db.from(table).select('*').eq('id',id).maybeSingle());
  const rpc=(name,args)=>get(db.rpc(name,args));
  const list=async(table,column,value,fields='*')=>{const rows=await get(db.from(table).select(fields).eq(column,value).limit(1000));if(!Array.isArray(rows)||rows.length>=1000)throw Error('bounded_history_incomplete');return rows;};
  const assignment=await one('mission_assignments',task.id);
  const snapshot=async()=>{
   const [account,mission,calls,assignments,control,limit,callLimit,live,currentApproval,currentProject]=await Promise.all([
    one('benchmark_budget_accounts',approval.account_id),one('agent_missions',assignment.mission_id),list('benchmark_budget_calls','account_id',approval.account_id),list('mission_assignments','mission_id',assignment.mission_id),
    rpc('benchmark_full_monetary_control',{p_account:approval.account_id,p_continuation:continuation?.id}),
    rpc('benchmark_effective_mission_allowance',{p_mission:assignment.mission_id,p_continuation:continuation?.id}),
    rpc('benchmark_effective_mission_call_limit',{p_mission:assignment.mission_id,p_continuation:continuation?.id}),
    rpc('benchmark_continuation_live',{p_id:continuation?.id,p_account:approval.account_id,p_project:project.id}),
    one('benchmark_native_spending_approvals',approval.id),one('work_projects',project.id)]);
   if(assignments.length>50)throw Error('bounded_history_incomplete');
   const jobCalls=(await Promise.all(assignments.map(a=>list('mission_calls','job_id',a.id)))).flat();
   if(jobCalls.length>=1000||assignments.length>50)throw Error('bounded_history_incomplete');
   return {account,mission,calls,jobCalls,control,limit,callLimit,live,currentApproval,currentProject};
  };
  // A forecast is not an atomic admission. Detect a changing multi-read snapshot
  // and report unknown instead of presenting a mixture as authoritative capacity.
  const first=await snapshot(),s=await snapshot();if(canonical(first)!==canonical(s))throw Error('snapshot_changed');
  const plan=continuation?.plan;
  if(![5,6].includes(plan?.version)||s.control?.version!=='atomic-exposure-v1')throw Error('unsupported_capacity_contract');
  if(s.account.id!==approval.account_id||s.mission.project_id!==project.id||s.currentProject.approved_hash!==project.approved_hash||s.currentProject.approval_hash!==project.approved_hash||s.currentApproval.task_id!==task.id||s.currentApproval.project_id!==project.id)throw Error('snapshot_identity_mismatch');
  const jobIds=new Set(s.jobCalls.map(x=>x.id));
  const developmentCalls=s.calls.filter(c=>jobIds.has(c.legacy_mission_call_id??c.request_key));
  if(developmentCalls.length!==s.jobCalls.length||developmentCalls.length!==sum([s.mission.calls,s.mission.routing_calls]))throw Error('unlinked_mission_calls');
  const holds=sum(s.calls.filter(c=>['reserved','unresolved'].includes(c.state)).map(c=>c.reserved_tokens));
  const accountUsed=sum([s.account.spent_tokens,holds]);
  const actual=number(s.mission.actual_tokens),reserved=number(s.mission.reserved_tokens);
  const developmentUsed=actual===null||reserved===null?null:Math.max(actual,reserved);
  const deadlines=[s.currentApproval.deadline,s.currentProject.deadline,continuation.deadline].map(stamp);
  let deadline=deadlines.every(x=>x!==null)?Math.min(...deadlines):null;
  const grant=grantId?await one('benchmark_execution_grants',grantId):null;
  const grantLive=grantId?Boolean(grant&&grant.account_id===approval.account_id&&grant.project_id===project.id&&grant.mission_assignment_id===task.id&&grant.continuation_id===continuation.id&&typeof approval.trial_id==='string'&&grant.trial_id===approval.trial_id&&!grant.revoked_at&&!grant.stopped_at&&stamp(grant.deadline)>now):null;
  if(grantId){const grantDeadline=stamp(grant?.deadline);deadline=deadline!==null&&grantDeadline!==null?Math.min(deadline,grantDeadline):null;}
  input.authorization={executionAuthorized:grantLive,source:'existing_effective_budget_rpcs_and_accounting_rows',live:s.live===true&&!s.account.frozen_at&&!s.currentApproval.revoked_at&&s.currentProject.status==='running',deadline,
   tokens:{cumulativeLimit:number(s.control.cumulativeTokenCap),accountEncumbered:accountUsed,developmentLimit:number(s.limit),developmentEncumbered:developmentUsed,completionReserveRemaining:number(plan.developmentClosureTokens),assessmentReserveRemaining:number(plan.assessmentTokens)},
   calls:{developmentLimit:number(s.callLimit),developmentConsumed:developmentCalls.length,completionReserveRemaining:number(plan.developmentClosureCalls),assessmentLimit:null,assessmentConsumed:null},
   money:{complete:true,ceilingMicrousd:numericString(s.control.dollarCeilingMicrousd),exposureMicrousd:numericString(s.control.exposureMicrousd)}};
  let prices=null;try{prices=await get(db.from('model_registry').select('model_id,pricing_status,pricing_input_per_1m::text,pricing_output_per_1m::text,pricing_verified_at').eq('provider_name','openai').eq('model_id',approval.model).maybeSingle());}catch{}
  if(prices)input.pricing.native={status:prices.pricing_status,source:'verified_model_registry',serviceTier:plan.serviceTier,verifiedAt:stamp(prices.pricing_verified_at),inputUsdPerMillion:numericString(prices.pricing_input_per_1m),outputUsdPerMillion:numericString(prices.pricing_output_per_1m)};
  // Completion/assessment routing has not yet selected a model. Do not reuse
  // the native price or pretend the cheapest registry model will be selected.
  const seenOperations=new Set();
  input.observations=observations.filter(o=>{
   if(!Array.isArray(o.operationIds)||!o.operationIds.length||o.operationIds.length!==o.calls||new Set(o.operationIds).size!==o.calls)return false;
   const rows=o.operationIds.map(id=>s.calls.find(c=>c.id===id));
   if(o.operationIds.some(id=>seenOperations.has(id)))return false;
   const valid=rows.every(c=>c?.state==='settled'&&c.model===approval.model&&c.provider_usage)&&
    sum(rows.map(c=>c.provider_usage.input_tokens))===o.inputTokens&&sum(rows.map(c=>c.provider_usage.output_tokens))===o.outputTokens;
   if(valid)o.operationIds.forEach(id=>seenOperations.add(id));return valid;
  });
  const result=assessLifecycleCapacity(input);
  result.snapshot={accountId:s.account.id,missionId:s.mission.id,continuationId:continuation.id,approvalId:approval.id,callRows:s.calls.length,missionCallRows:s.jobCalls.length};
  result.uncertainties.push('peak_request_reservation_not_predicted','future_completion_and_assessment_routing_unknown','additional_repairs_outside_current_bounded_iteration_not_authorized');
  return result;
 }catch{
  const result=assessLifecycleCapacity({...input,authorization:{}});
  result.uncertainties.push('authoritative_snapshot_unavailable_or_changed');return result;
 }
}
