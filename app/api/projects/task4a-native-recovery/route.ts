import {NextRequest,NextResponse} from 'next/server';
import {z} from 'zod';
import {verifiedProjectOwnerSession} from '@/lib/projects/owner-authorization';
import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';

export const runtime='nodejs';
const ORIGINAL='6d1c29f1-b31e-47a5-aabb-cbcf1326f388';
const approval=z.object({confirm:z.literal(true),
 proposalDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
type RecoveryProposal={ready:boolean;digest:string;proposal:{
 projectId:string;taskId:string;ownerId:string;oldApprovalId:string;
 continuationId:string;limits:Record<string,number>;
 originalNativeDeadline:string;continuationDeadline:string;replacementDeadline:string;
}};
const reply=(data:unknown,status=200)=>NextResponse.json(data,{status,headers:{'Cache-Control':'private, no-store'}});
export async function GET(request:NextRequest){
 if(!await verifiedProjectOwnerSession(request))return reply({error:'Owner sign-in required'},401);
 const {data,error}=await getSupabaseAdminClient().rpc<RecoveryProposal|null>('task4a_native_recovery_proposal');
 if(error)return reply({error:'Recovery proposal unavailable'},503);
 if(!data||data.ready!==true)return reply({ready:false,
  error:'Existing authorization, original failed workflow, or continuation deadline is no longer eligible'},409);
 return reply({ready:true,digest:data.digest,proposal:data.proposal,
  existingProjectId:ORIGINAL,noNewProject:true,
  oldApprovalUnchangedUntilExplicitConsent:true,
  noAdditionalSpendingAuthorizedByViewing:true});
}
export async function POST(request:NextRequest){
 if(!await verifiedProjectOwnerSession(request))return reply({error:'Authenticated owner consent required'},403);
 let input:z.infer<typeof approval>;
 try{input=approval.parse(await request.json());}
 catch{return reply({error:'Exact displayed digest and explicit consent required'},400);}
 const db=getSupabaseAdminClient();
 const {data:proposal,error:proposalError}=await db.rpc<RecoveryProposal|null>('task4a_native_recovery_proposal');
 if(proposalError||!proposal||proposal.digest!==input.proposalDigest)
  return reply({error:'Saved proposal changed or expired. Refresh before approving.'},409);
 const {data:recovered,error}=await db.rpc<{recovered:boolean;receiptId:string;newApprovalId:string;nativeDeadline:string}>(
  'task4a_confirm_pregrant_recovery',{
   p_owner:proposal.proposal.ownerId,p_digest:input.proposalDigest
  });
 if(error||recovered?.recovered!==true)return reply({error:'Atomic owner-confirmed recovery was rejected; no new authority may be assumed'},409);
 return reply({accepted:true,receiptId:recovered.receiptId,
  taskId:proposal.proposal.taskId,oldApprovalId:proposal.proposal.oldApprovalId,
  replacementApprovalId:recovered.newApprovalId,
  nativeDeadline:recovered.nativeDeadline,
  sameAccountSameLimits:true,oldApprovalPreserved:true,
  priorFailedIssueReused:true,noProductionPublication:true});
}
