import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { authorizeStandaloneCaller } from './auth';
import { StandaloneAccountingError } from './ledger';
import { getSupabaseAdminClient } from '@/lib/data/supabase/admin';
import { assertCronAuth } from '@/lib/runpod/durable-results';
import { runWithStandaloneAccounting, isStandaloneAccountingError, standaloneAccountingCause, standaloneFailureDetails, standaloneTechnicalBlocker } from './context';
import { canonicalJson, type JsonValue } from './estimate';

type Workflow = {owner_id:string;actor_id:string;chat_id:string;request_id:string;request_hash:string;request_body:Record<string,unknown>;status:string;lease_token:string;created_at:string;checkpoints:Record<string,unknown>;claimed?:boolean;blocked?:string;result?:{body:string;status:number;headers:[string,string][]}};
const workflowScope = new AsyncLocalStorage<{workflow:Workflow;resumed:boolean}>();
export const currentStandaloneWorkflow = () => workflowScope.getStore();
export function workflowMessageId(label:string):string|undefined {
  const scope = workflowScope.getStore();
  if (!scope) return undefined;
  const hex=createHash('sha256').update(`${scope.workflow.owner_id}:${scope.workflow.request_id}:${label}`).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
export function workflowTimestamp():string { return workflowScope.getStore()?.workflow.created_at ?? new Date().toISOString(); }
export async function cachedWorkflowValue<T>(key:string,load:()=>Promise<T>):Promise<T> {
  const scope=workflowScope.getStore();if(!scope)return load();
  if(Object.prototype.hasOwnProperty.call(scope.workflow.checkpoints??{},key))return scope.workflow.checkpoints[key] as T;
  const value=await load();
  const saved=await rpc<T>('checkpoint_workflow',{p_owner:scope.workflow.owner_id,p_request:scope.workflow.request_id,p_lease:scope.workflow.lease_token,p_key:key,p_value:value??null});
  (scope.workflow.checkpoints??={})[key]=saved;return saved;
}
async function rpc<T>(name:string,args:Record<string,unknown>):Promise<T> {
  const {data,error}=await getSupabaseAdminClient().rpc<T>(`standalone_${name}`,args);
  if(error)throw new StandaloneAccountingError('workflow_unavailable',error.message);
  return data;
}

/** Cron may resume ONLY a persisted, owner-bound Qwen job which was paused
 * because RunPod was still processing. It cannot create work, approve spending,
 * change the request, or bypass the original actor/chat authorization. */
async function verifiedCronQwenOwner(actorId:string,chatId:string,requestId:string):Promise<string> {
  // The original ledger tables are intentionally not selectable by service_role.
  // Keep the existing cron bearer check in executeStandaloneWorkflow, and use
  // only the narrow security-definer lookup for a paused, accepted Qwen job.
  const {data:ownerId,error}=await getSupabaseAdminClient().rpc<string|null>(
    'standalone_verified_cron_qwen_owner',
    {p_actor:actorId,p_chat:chatId,p_request:requestId},
  );
  if(error||!ownerId)
    throw new StandaloneAccountingError('resume_denied','No paused Qwen workflow is eligible for automatic continuation.');
  return ownerId;
}

/** Persist original user input before any paid preparation. Each resume runs under
 * a fenced lease; completed provider responses replay from the attempt ledger. */
export async function executeStandaloneWorkflow(request:NextRequest,payload:Record<string,unknown>,execute:(request:NextRequest)=>Promise<Response>):Promise<Response> {
  const actorId=String(payload.actorId??''),chatId=String(payload.chatId??'');
  const requestId=request.headers.get('x-request-id')?.trim();
  if(!requestId||!/^[A-Za-z0-9._:-]{1,128}$/.test(requestId))throw new StandaloneAccountingError('request_id_required','A stable original request ID is required before paid processing.');
  const resumed=payload.standaloneResume===true;
  const ownerId=resumed&&assertCronAuth(request)
    ? await verifiedCronQwenOwner(actorId,chatId,requestId)
    : await authorizeStandaloneCaller(request,actorId,chatId);
  if(resumed) {
    const saved=await rpc<Workflow|null>('load_workflow',{p_owner:ownerId,p_request:requestId});
    if(!saved||saved.actor_id!==actorId||saved.chat_id!==chatId)throw new StandaloneAccountingError('resume_denied','Saved request not found for this owner and conversation.');
    payload=saved.request_body;
  }
  const hash=createHash('sha256').update(canonicalJson(payload as JsonValue)).digest('hex');
  const workflow=await rpc<Workflow>('claim_workflow',{p_owner:ownerId,p_actor:actorId,p_chat:chatId,p_request:requestId,p_hash:hash,p_body:payload,p_resume:resumed});
  if(!workflow.claimed) {
    if(workflow.status==='completed'&&workflow.result)return new Response(workflow.result.body,{status:workflow.result.status,headers:workflow.result.headers});
    return NextResponse.json({status:workflow.blocked??workflow.status,requestId,error:workflow.blocked==='approval_required'?'Approval required. Review the saved provider attempt in Usage.':workflow.blocked},{status:202});
  }
  const finish=async(status:'paused'|'completed'|'failed',result?:Workflow['result'],error?:string)=>rpc<Workflow>('finish_workflow',{p_owner:ownerId,p_request:requestId,p_lease:workflow.lease_token,p_status:status,p_result:result??null,p_error:error??null});
  const headers=new Headers(request.headers);headers.set('content-type','application/json');
  const original=new NextRequest(request.url,{method:'POST',headers,body:JSON.stringify(payload),signal:request.signal});
  try {
    return await workflowScope.run({workflow,resumed},()=>runWithStandaloneAccounting({userId:ownerId,actorId,chatId,requestId,resumed,signal:request.signal,activity:'chat',reason:'Original standalone user request'},async()=>{
      const response=await execute(original);
      // Consume in the originating scope even after HTTP return. The durable
      // result also makes reconnects independent of browser memory.
      const reader=response.body?.getReader();
      if(!reader) {await finish(response.ok?'completed':'failed');return response;}
      const ndjson=response.headers.get('content-type')?.includes('ndjson')??false;
      const chunks:Uint8Array[]=[];let byteLength=0;
      const record=(chunk:Uint8Array)=>{chunks.push(chunk);byteLength+=chunk.byteLength;};
      const collected=()=>{const bytes=new Uint8Array(byteLength);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;};
      const settle=async(bytes:Uint8Array)=>{
        const body=new TextDecoder().decode(bytes);
        const events=ndjson ? body.split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}) : [];
        let jsonError:unknown;try{jsonError=JSON.parse(body);}catch{/* Streaming body is parsed above. */}
        const technicalEvent=[...events,...(jsonError&&typeof jsonError==='object'?[jsonError]:[])].find(event=>
          (['accounting_pause','error','reasoning_error'].includes(event.type)||event.error)&&standaloneTechnicalBlocker(event.code));
        const technical=Boolean(technicalEvent);
        const paused=!technical&&/"type":"accounting_pause"|"code":"standalone_/.test(body);
        const executionFailure=events.find(event=>event.type==='error'||event.type==='reasoning_error');
        const failureMessage=technicalEvent ? String(technicalEvent.code)+': '+String(technicalEvent.message??technicalEvent.error??'Image inspection is unsupported.').slice(0,1800) : executionFailure ? String(executionFailure.message??executionFailure.error??'Saved request execution failed.') : undefined;
        const result={body,status:response.status,headers:Array.from(response.headers.entries())};
        const finished=await finish(paused?'paused':response.ok&&!executionFailure&&!technical?'completed':'failed',result,failureMessage);
        if(finished.status==='paused'&&!paused&&!executionFailure&&!technical)
          return {type:'accounting_pause',code:'standalone_pending_attempt',requestId,message:'Supporting work is paused for approval or unresolved accounting. Review Usage.'};
        return null;
      };

      if(ndjson){
        // Do not wait for the entire standalone workflow before returning HTTP.
        // Forward bytes as generated while retaining an exact durable replay
        // and completing the accounting lease before the stream is closed.
        let disconnected=false;
        const passthrough=new ReadableStream<Uint8Array>({
          start(controller){
            void (async()=>{
              try{
                while(true){
                  const {value,done}=await reader.read();
                  if(done)break;
                  if(value){record(value);if(!disconnected)controller.enqueue(value);}
                }
                const notice=await settle(collected());
                if(notice&&!disconnected)controller.enqueue(new TextEncoder().encode(JSON.stringify(notice)+'\n'));
                if(!disconnected)controller.close();
              }catch(error){
                // A stream read or settlement failure must not silently count
                // as completed work or abandon an owner-fenced workflow.
                try{await finish('failed',undefined,standaloneFailureDetails(error));}
                catch(finishError){console.error('[Standalone Workflow] Failed to record stream failure',finishError);}
                if(!disconnected)controller.error(error);
              }
            })();
          },
          // A browser disconnect never cancels the source: paid generation
          // must reach its saved accounting/replay checkpoint.
          cancel(){disconnected=true;}
        });
        const headers=new Headers(response.headers);
        headers.set('Cache-Control','no-cache, no-transform');
        headers.set('X-Accel-Buffering','no');
        headers.delete('Content-Length');
        return new Response(passthrough,{status:response.status,headers});
      }

      while(true){const {value,done}=await reader.read();if(done)break;if(value)record(value);}
      const bytes=collected();
      const notice=await settle(bytes);
      if(notice)return NextResponse.json(notice,{status:402});
      return new Response(bytes,{status:response.status,headers:response.headers});
    }));
  } catch(error) {
    const terminal=isStandaloneAccountingError(error)&&!standaloneTechnicalBlocker(standaloneAccountingCause(error)?.code);
    error=standaloneAccountingCause(error)??error;
    const finished=await finish(terminal?'paused':'failed',undefined,standaloneFailureDetails(error));
    if (finished.status==='paused'&&!terminal) throw Object.assign(new StandaloneAccountingError('pending_attempt',`Saved request execution failed: ${standaloneFailureDetails(error)}. Existing spending exposure remains held.`),{cause:error});
    throw error;
  }
}
