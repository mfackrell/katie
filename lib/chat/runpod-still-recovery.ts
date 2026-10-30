import { NextRequest } from 'next/server';
import { getSupabaseAdminClient } from '@/lib/data/supabase/admin';
import { QWEN_STILL_POLICY } from '@/lib/standalone-accounting/runpod-policy';
import { requireRunpodKey } from '@/lib/runpod/durable-results';

const JOB_ID=/^[A-Za-z0-9-]{8,150}$/;
const TERMINAL=new Set(['COMPLETED','FAILED','CANCELLED','TIMED_OUT']);
const MAX_RESUMES_PER_TICK=2;

export type SavedQwenJob={
  owner_id:string;actor_id:string;chat_id:string;request_id:string;
  provider_request_id:string;state:string;
};
export type QwenRecoveryResult={
  inspected:number;waiting:number;resumed:number;deferred:number;failed:number;
};
export type QwenJobStatus='waiting'|'terminal'|'expired'|'unavailable';
export type QwenRecoveryDependencies={
  list:()=>Promise<SavedQwenJob[]>;
  eligible:(job:SavedQwenJob)=>Promise<boolean>;
  status:(job:SavedQwenJob)=>Promise<QwenJobStatus>;
  resume:(job:SavedQwenJob)=>Promise<boolean>;
};

/** Only poll accepted RunPod IDs. Never resubmit a GPU job or advance
 * the saved chat until RunPod reports a terminal result. A paused parent
 * is resumed using its original request/body and the database lease fence. */
export async function reconcileSavedQwenJobs(deps:QwenRecoveryDependencies):Promise<QwenRecoveryResult>{
  const result:QwenRecoveryResult={inspected:0,waiting:0,resumed:0,deferred:0,failed:0};
  const jobs=await deps.list();
  for(const job of jobs){
    if(!JOB_ID.test(job.provider_request_id)||!await deps.eligible(job))continue;
    result.inspected++;
    try{
      const status=await deps.status(job);
      if(status==='waiting'){result.waiting++;continue;}
      if(status==='unavailable'){result.deferred++;continue;}
      // Expiration is terminal too: the saved runner reports the actual
      // unavailable result instead of inventing an image description.
      if(result.resumed>=MAX_RESUMES_PER_TICK){result.deferred++;continue;}
      if(await deps.resume(job))result.resumed++;
      else result.deferred++;
    }catch(error){
      result.failed++;
      console.error('[QwenRecovery] saved job check failed',{
        requestId:job.request_id,
        errorName:error instanceof Error?error.name:'UnknownError',
      });
    }
  }
  return result;
}

async function listPendingQwenJobs():Promise<SavedQwenJob[]>{
  const {data,error}=await getSupabaseAdminClient().from('standalone_provider_attempts')
    .select('owner_id,actor_id,chat_id,request_id,provider_request_id,state')
    .eq('provider','runpod').eq('model',QWEN_STILL_POLICY.model)
    .eq('pricing_version',QWEN_STILL_POLICY.version).eq('state','dispatched')
    .not('provider_request_id','is',null).is('response_checkpoint',null)
    .order('created_at',{ascending:true}).limit(30);
  if(error)throw new Error('Saved RunPod attempt lookup failed.');
  return (data??[]) as SavedQwenJob[];
}

async function eligibleSavedWorkflow(job:SavedQwenJob):Promise<boolean>{
  const {data,error}=await getSupabaseAdminClient().from('standalone_workflows')
    .select('status,error').eq('owner_id',job.owner_id).eq('actor_id',job.actor_id)
    .eq('chat_id',job.chat_id).eq('request_id',job.request_id)
    .maybeSingle<{status:string;error:string|null}>();
  if(error)throw new Error('Saved RunPod workflow lookup failed.');
  return data?.status==='paused'&&Boolean(data.error?.includes('standalone_runpod_in_progress'));
}

async function inspectRunpodStatus(job:SavedQwenJob):Promise<QwenJobStatus>{
  const response=await fetch('https://api.runpod.ai/v2/'+QWEN_STILL_POLICY.endpointId+
      '/status/'+encodeURIComponent(job.provider_request_id),{
    method:'GET',
    headers:{Authorization:'Bearer '+requireRunpodKey(),Accept:'application/json'},
    cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15_000),
  });
  if(response.status===404){await response.body?.cancel();return 'expired';}
  if(!response.ok){await response.body?.cancel();return 'unavailable';}
  const data=await response.json() as {id?:string;status?:string};
  if(data.id!==job.provider_request_id)throw new Error('RunPod returned a mismatched saved job ID.');
  if(TERMINAL.has(data.status??''))return 'terminal';
  if(data.status==='IN_QUEUE'||data.status==='IN_PROGRESS')return 'waiting';
  return 'unavailable';
}

/** This is an in-process invocation of the existing chat entrypoint:
 * no open user credential is stored, and the trusted cron authorization
 * can ONLY resume an accepted paused Qwen attempt, never create a new one. */
async function resumeSavedChat(job:SavedQwenJob):Promise<boolean>{
  const secret=process.env.CRON_SECRET;
  if(!secret)throw new Error('Cron authentication is unavailable.');
  const {POST}=await import('@/app/api/chat/route');
  const request=new NextRequest('https://katie-internal.invalid/api/chat',{
    method:'POST',
    headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json',
      'x-request-id':job.request_id},
    body:JSON.stringify({actorId:job.actor_id,chatId:job.chat_id,standaloneResume:true}),
  });
  const response=await POST(request);
  // Consume the saved response: workflow.ts only finalizes the database
  // checkpoint after its stream has been consumed.
  const body=await response.text();
  if(!response.ok||response.status===202)return false;
  if(body.includes('"type":"accounting_pause"')||
    body.includes('"type":"reasoning_error"')||body.includes('"type":"error"'))return false;
  return true;
}

export async function reconcileWaitingQwenJobs():Promise<QwenRecoveryResult>{
  return reconcileSavedQwenJobs({
    list:listPendingQwenJobs,
    eligible:eligibleSavedWorkflow,
    status:inspectRunpodStatus,
    resume:resumeSavedChat,
  });
}
