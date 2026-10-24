// Enforce budget authorization at the trusted server boundary.
// Verifier must read an owner-approved, immutable record from durable storage;
// client-provided approved=true and model-generated text are not authorization.
export function verifyBudgetGrant(grant,{ownerActorId,projectId,priorCeiling,usedApprovalIds=[]}){
 if(!grant||grant.status!=='approved'||grant.actor_id!==ownerActorId||
    grant.project_id!==projectId||grant.purpose!=='benchmark_budget_increase'||
    typeof grant.id!=='string'||!grant.id||
    usedApprovalIds.includes(grant.id)||
    !Number.isSafeInteger(grant.new_ceiling)||grant.new_ceiling<=priorCeiling||
    !Number.isSafeInteger(grant.previous_ceiling)||grant.previous_ceiling!==priorCeiling||
    typeof grant.approved_at!=='string'||!grant.approved_at)
    throw Error('OWNER_BUDGET_APPROVAL_REQUIRED');
 return {verified:true,actorRole:'owner',scope:'take-eleven-benchmark',
         approvalId:grant.id,newCeiling:grant.new_ceiling};
}
// This adapter does not persist a grant or establish identity: caller MUST
// source both project owner and approval row from trusted server-side database.
export async function applyStoredOwnerGrant(budget,{readGrant,ownerActorId,projectId,grantId}){
 if(typeof readGrant!=='function')throw Error('TRUSTED_APPROVAL_STORE_REQUIRED');
 return budget.approveIncrease(grantId,async()=>{
   const grant=await readGrant({projectId,grantId});
   return verifyBudgetGrant(grant,{ownerActorId,projectId,priorCeiling:budget.capTokens,
     usedApprovalIds:budget.approvals.map(x=>x.approvalId)});
 });
}
