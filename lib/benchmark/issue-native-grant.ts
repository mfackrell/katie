import {randomBytes,createHash} from 'node:crypto';
import {authorizeSelfToolCaller} from '../../lib/tools/authorization';

/** Trusted server process only. Provisioning requires authenticated user AND
 * a separate durable benchmark spending approval; self-tool access is not enough. */
type GrantRequest={request:Pick<Request,'headers'>;actorId:string;chatId:string;trialId:string;
 approvalId:string;repository:string;model:string;epoch:number;deadline:string;
 db:{rpc:(name:string,args:Record<string,unknown>)=>Promise<{data:unknown;error:unknown}>}};
export async function issueNativeExecutionGrant({request,actorId,chatId,trialId,
 approvalId,repository,model,epoch,deadline,db}:GrantRequest){
 if(!db || typeof db.rpc!=='function'||!request||!approvalId||
    !Number.isSafeInteger(epoch)||epoch<=0)throw Error('BENCHMARK_GRANT_INPUT_INVALID');
 const ownerId=await authorizeSelfToolCaller(request,actorId,chatId);
 const token=randomBytes(48).toString('base64url');
 const digest=createHash('sha256').update(token).digest('hex');
 const {data,error}=await db.rpc('benchmark_issue_execution_grant',{
  p_owner:ownerId,p_actor:actorId,p_chat:chatId,p_trial:trialId,
  p_approval:approvalId,p_repository:repository,p_model:model,
  p_epoch:epoch,p_deadline:deadline,p_digest:digest
 });
 if(error||!data)throw Error('BENCHMARK_SPENDING_APPROVAL_DENIED');
 return {token,grantId:data,ownerId};
}
