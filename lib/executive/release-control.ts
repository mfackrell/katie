import {Octokit} from '@octokit/rest';
import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';
import {saveMessage} from '@/lib/data/persistence-store';
import {createHash} from 'node:crypto';

type Receipt={version:number;repository:string;run_id:number;issue_number:number;pr_url:string|null;
 outcome:string;tested_head_sha?:string|null;reviewed_head_sha?:string|null;
 checks:{build:string;test:string;review:string;retest:string;final_review:string}};
type Delivery={external?:{receipt?:Receipt}};
function client(){const token=process.env.GITHUB_TOKEN;if(!token)throw Error('GitHub release authority unavailable');return new Octokit({auth:token});}
function ids(prUrl:string){
 const m=/^https:\/\/github[.]com\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)$/.exec(prUrl);
 if(!m)return null;
 return{owner:m[1],repo:m[2],pr:Number(m[3])};
}
export function authorizedReleaseObjective(message:string){
 // The original request, not system-added workflow wording, controls the release scope.
 const original=message.split('\\nCONNECTED REPOSITORY:')[0];
 return /\b(?:deploy|release|publish)\s+(?:the\s+)?(?:changes|result|application|app|software|code|release|website)?\s*(?:to\s+)?production\b/i.test(original)
  && !/\b(?:do not|don't|never|without permission to)\s+(?:merge|deploy|release|publish)\b/i.test(original);
}
export function releaseReceiptFromResult(result:Delivery){
 const receipt=result.external?.receipt;if(!receipt||receipt.outcome!=='READY'||receipt.version!==1)return null;
 const parts=receipt.pr_url?ids(receipt.pr_url):null;
 if(!parts||receipt.repository!==parts.owner+'/'+parts.repo||
  !/^[a-f0-9]{40}$/.test(receipt.tested_head_sha??'')||
  receipt.tested_head_sha!==receipt.reviewed_head_sha||
  receipt.checks.build!=='success'||
  !(receipt.checks.test==='true'&&receipt.checks.review==='pass'||
    receipt.checks.retest==='true'&&receipt.checks.final_review==='pass'))return null;
 return{...parts,receipt};
}
export async function dispatchReviewedRelease(input:{delegationId:string;missionId:string}){
 const db=getSupabaseAdminClient();
 const {data:prior,error:priorError}=await db.from('executive_delegation_events')
  .select('id').eq('delegation_id',input.delegationId).in('event',['release_dispatched','release_verified']).limit(1);
 if(priorError)throw Error('Release dispatch inventory unavailable');
 if(prior?.length)return 'already_dispatched';
 const {data:jobs,error:jobsError}=await db.from('mission_assignments')
  .select('result,status').eq('mission_id',input.missionId).eq('role','development').eq('status','completed').limit(10)
  .returns<{result:Delivery;status:string}>();
 if(jobsError)throw Error('Development receipts unavailable');
 const matches=(jobs??[]).map(j=>releaseReceiptFromResult(j.result)).filter((r):r is NonNullable<typeof r>=>r!==null);
 if(matches.length!==1)throw Error('Production release requires exactly one verified development PR');
 const {owner,repo,pr,receipt}=matches[0];
 if(owner!=='mfackrell'||repo!=='katie')throw Error('No trusted release workflow configured for this connected repository');
 const gh=client();
 await gh.actions.createWorkflowDispatch({
  owner,repo,workflow_id:'executive-autonomous-release.yml',ref:'main',
  inputs:{pr_number:String(pr),issue_number:String(receipt.issue_number),
    run_id:String(receipt.run_id),head_sha:receipt.tested_head_sha!}
 });
 const {error:recordError}=await db.from('executive_delegation_events').insert({
  delegation_id:input.delegationId,event:'release_dispatched',
  evidence:{repository:owner+'/'+repo,pr,runId:receipt.run_id,sha:receipt.tested_head_sha}
 });
 if(recordError)throw Error('Release requested but durable dispatch receipt unavailable');
 return 'dispatched';
}
// Release state is append-only; callers can distinguish a pending release from a verified one.
export async function releaseStatus(delegationId:string){
 const db=getSupabaseAdminClient();
 const {data,error}=await db.from('executive_delegation_events').select('event,evidence,created_at')
  .eq('delegation_id',delegationId).in('event',['release_dispatched','release_verified','release_blocked'])
  .order('created_at',{ascending:false}).limit(20);
 if(error)throw Error('Release status unavailable');
 const events=(data??[]) as Array<{event:string;evidence:unknown;created_at:string}>;
 return {state:events.some(e=>e.event==='release_verified')?'verified':events.some(e=>e.event==='release_dispatched')?'dispatched':events.some(e=>e.event==='release_blocked')?'blocked':'not_requested',events};
}

export async function reconcileExecutiveReleases(){
 const db=getSupabaseAdminClient();
 const {data:events,error}=await db.from('executive_delegation_events')
  .select('id,delegation_id,event,evidence').eq('event','release_dispatched').limit(75)
  .returns<{id:string;delegation_id:string;evidence:{repository:string;pr:number;sha:string}}>();
 if(error)throw Error('Release verification inventory unavailable');
 let verified=0;
 for(const event of events??[]){
  const {data:completed}=await db.from('executive_delegation_events')
   .select('id').eq('delegation_id',event.delegation_id).eq('event','release_verified').limit(1);
  if(completed?.length)continue;
  if(event.evidence.repository!=='mfackrell/katie')continue;
  const gh=client();
  let pull;
  try{({data:pull}=await gh.pulls.get({owner:'mfackrell',repo:'katie',pull_number:event.evidence.pr}));}
  catch(error){console.error('[Executive release] PR lookup failed',event.delegation_id,error instanceof Error?error.message:'unknown');continue;}
  if(!pull.merged||!pull.merge_commit_sha)continue;
  if(event.evidence.sha!==pull.head.sha){
   console.error('[Executive release] PR head changed after dispatch',event.delegation_id);
   continue;
  }
  const status=await gh.repos.getCombinedStatusForRef({owner:'mfackrell',repo:'katie',ref:pull.merge_commit_sha});
  if(!status.data.statuses.some(s=>s.context==='Vercel'&&s.state==='success'))continue;
  const {data:delegation}=await db.from('executive_delegations')
   .select('chat_id').eq('id',event.delegation_id).maybeSingle<{chat_id:string}>();
  if(!delegation)continue;
  const {error:saveError}=await db.from('executive_delegation_events').insert({
   delegation_id:event.delegation_id,event:'release_verified',
   evidence:{pr:event.evidence.pr,mergeSha:pull.merge_commit_sha,vercelStatus:'success'}
  });
  if(saveError)throw Error('Release verified but ledger write failed');
  const h=createHash('sha256').update('executive-release-reply:'+event.delegation_id).digest('hex');
  const messageId=[h.slice(0,8),h.slice(8,12),'4'+h.slice(13,16),'8'+h.slice(17,20),h.slice(20,32)].join('-');
  const {data:previous}=await db.from('messages').select('id').eq('id',messageId).maybeSingle<{id:string}>();
  if(!previous)await saveMessage(delegation.chat_id,{id:messageId,role:'assistant',
   content:'Development release confirmed: PR #'+event.evidence.pr+
   ' was merged after same-commit tests and independent review. GitHub confirms Vercel deployed commit '+
   pull.merge_commit_sha+'. This establishes deployment, not application-specific browser acceptance.'});
  verified++;
 }
 return{verified};
}
