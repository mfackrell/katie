import {meteredRequest} from './metered-request.mjs';
// Caller supplies a trusted service-role RPC client created server-side only.
// This bridge does not grant project approval or automatically launch inference.
export function durableBenchmarkAdapter(db,accountId) {
 if(!db || typeof db.rpc!=='function' || typeof accountId!=='string' || !accountId)
  throw Error('BENCHMARK_TRUSTED_DB_REQUIRED');
 const call=async(name,args)=>{
  const {data,error}=await db.rpc(name,args);
  if(error)throw Error('BENCHMARK_LEDGER_RPC_FAILED: '+name);
  return data;
 };
 return {
  execute:async({requestId,model,maxInputTokens,maxOutputTokens,invoke})=>
   meteredRequest({
    requestId,model,maxInputTokens,maxOutputTokens,invoke,
    reserve:async({requestId,model,upperTokens})=>{
      const id=await call('benchmark_reserve_call',{p_account:accountId,p_key:requestId,p_model:model,p_tokens:upperTokens});
      return {accepted:typeof id==='string'&&id.length>0,id};
    },
    finalize:async({reservationId,status,usage})=>{
      if(status!=='completed')return {committed:false}; // unresolved hold persists in the database
      const actual=usage.inputTokens+usage.outputTokens;
      return {committed:await call('benchmark_settle_call',{p_call:reservationId,p_actual:actual})===true};
    }
   }),
  redeemApprovedIncrease:async(approvalId)=>{
   if(typeof approvalId!=='string'||!approvalId)throw Error('BENCHMARK_APPROVAL_ID_REQUIRED');
   return call('benchmark_redeem_approval',{p_approval:approvalId});
  }
 };
}
