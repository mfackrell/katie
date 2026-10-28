import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { authorizeStandaloneCaller } from './auth';
import { StandaloneAccountingError } from './ledger';
import { getSupabaseAdminClient } from '@/lib/data/supabase/admin';
import { runWithStandaloneAccounting } from './context';
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

/** Persist original user input before any paid preparation. Each resume runs under
 * a fenced lease; completed provider responses replay from the attempt ledger. */
export async function executeStandaloneWorkflow(request:NextRequest,payload:Record<string,unknown>,execute:(request:NextRequest)=>Promise<Response>):Promise<Response> {
  const actorId=String(payload.actorId??''),chatId=String(payload.chatId??'');
  const ownerId=await authorizeStandaloneCaller(request,actorId,chatId);
  const requestId=request.headers.get('x-request-id')?.trim();
  if(!requestId||!/^[A-Za-z0-9._:-]{1,128}$/.test(requestId))throw new StandaloneAccountingError('request_id_required','A stable original request ID is required before paid processing.');
  const resumed=payload.standaloneResume===true;
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
  const finish=async(status:'paused'|'completed'|'failed',result?:Workflow['result'],error?:string)=>rpc('finish_workflow',{p_owner:ownerId,p_request:requestId,p_lease:workflow.lease_token,p_status:status,p_result:result??null,p_error:error??null});
  const headers=new Headers(request.headers);headers.set('content-type','application/json');
  const original=new NextRequest(request.url,{method:'POST',headers,body:JSON.stringify(payload),signal:request.signal});
  try {
    return await workflowScope.run({workflow,resumed},()=>runWithStandaloneAccounting({userId:ownerId,actorId,chatId,requestId,signal:request.signal,activity:'chat',reason:'Original standalone user request'},async()=>{
      const response=await execute(original);
      // Consume in the originating scope even after HTTP return. The durable
      // result also makes reconnects independent of browser memory.
      const reader=response.body?.getReader();
      if(!reader) {await finish(response.ok?'completed':'failed');return response;}
      const chunks:Uint8Array[]=[];let byteLength=0;
      while(true){const {value,done}=await reader.read();if(done)break;chunks.push(value);byteLength+=value.byteLength;}
      const bytes=new Uint8Array(byteLength);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
      const body=new TextDecoder().decode(bytes);
      const paused=/"type":"accounting_pause"|"code":"standalone_/.test(body);
      const result={body,status:response.status,headers:Array.from(response.headers.entries())};
      await finish(paused?'paused':response.ok?'completed':'failed',result);
      return new Response(bytes,{status:response.status,headers:response.headers});
    }));
  } catch(error) {
    const terminal=error instanceof StandaloneAccountingError || Boolean(error&&typeof error==='object'&&'code' in error&&String(error.code).startsWith('standalone_'));
    await finish(terminal?'paused':'failed',undefined,error instanceof Error?error.message:String(error));
    throw error;
  }
}
