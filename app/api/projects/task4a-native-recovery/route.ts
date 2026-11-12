import {NextRequest,NextResponse} from 'next/server';
import {z} from 'zod';
import {verifiedProjectOwnerSession} from '@/lib/projects/owner-authorization';
import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';

export const runtime='nodejs';
const ORIGINAL='6d1c29f1-b31e-47a5-aabb-cbcf1326f388';
const ORIGINAL_TASK='d0e41ff5-149e-4319-9e65-dcc605fb75da';
const ORIGINAL_APPROVAL='ddccc7a1-743f-4031-8ecd-a6926568ca98';
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
 const db=getSupabaseAdminClient();
 const {data,error}=await db.rpc<RecoveryProposal|null>('task4a_native_recovery_proposal',{});
 if(error)return reply({error:'Recovery proposal unavailable'},503);
 if(!data||data.ready!==true){
  // Owner-only read-back of the committed approval: no new consent or grant.
  const {data:saved,error:savedError}=await db.from('benchmark_native_spending_approvals')
   .select('id,created_at,developer_authority')
   .eq('previous_developer_approval_id',ORIGINAL_APPROVAL)
   .eq('project_id',ORIGINAL).eq('task_id',ORIGINAL_TASK).maybeSingle();
  if(savedError)return reply({error:'Saved recovery status unavailable'},503);
  const record=saved as null|{created_at:string;developer_authority?:{
   task4aRecovery?:{version?:string;oldApprovalId?:string;issueNumber?:number;ownerConsentDigest?:string}
  }};
  const recovery=record?.developer_authority?.task4aRecovery;
  if(record&&recovery?.version==='preinference-invalid-handoff-v1'
   &&recovery?.oldApprovalId===ORIGINAL_APPROVAL&&recovery?.issueNumber===969
   &&typeof recovery?.ownerConsentDigest==='string')
   return reply({ready:false,recovered:true,recordedAt:record.created_at,
    originalIssueNumber:969,noNewSpendingAuthorized:true});
  return reply({ready:false,
   error:'Existing authorization, original failed workflow, or continuation deadline is no longer eligible'},409);
 }
 if(data.proposal?.ownerId!==process.env.KATIE_OWNER_AUTH_USER_ID)
  return reply({error:'Authenticated user is not the original Task 4A owner'},403);
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
 const {data:proposal,error:proposalError}=await db.rpc<RecoveryProposal|null>('task4a_native_recovery_proposal',{});
 if(proposalError||!proposal||proposal.digest!==input.proposalDigest)
  return reply({error:'Saved proposal changed or expired. Refresh before approving.'},409);
 if(proposal.proposal?.ownerId!==process.env.KATIE_OWNER_AUTH_USER_ID)
  return reply({error:'Original native owner does not match authenticated session'},403);
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
