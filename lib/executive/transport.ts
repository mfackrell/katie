import {createHash} from 'node:crypto';
import {NextRequest,NextResponse} from 'next/server';
import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';
import {saveMessage} from '@/lib/data/persistence-store';
import {handleExecutiveManagement} from '@/lib/executive/management';

type Command={actorId:string;chatId:string;message:string;activeRepoId?:string|null;
 images?:unknown[];fileReferences?:unknown[]};

function replyId(requestId:string,role:'user'|'assistant'){
 const hex=createHash('sha256').update('executive:'+role+':'+requestId).digest('hex');
 return [hex.slice(0,8),hex.slice(8,12),'4'+hex.slice(13,16),'8'+hex.slice(17,20),hex.slice(20,32)].join('-');
}
async function saveOnce(chatId:string,id:string,role:'user'|'assistant',content:string){
 const db=getSupabaseAdminClient();
 const {data,error}=await db.from('messages').select('id').eq('id',id).maybeSingle<{id:string}>();
 if(error)throw Error('Executive conversation persistence unavailable');
 if(!data)await saveMessage(chatId,{id,role,content,...(role==='assistant'?{model:'executive-manager'}:{})});
}
/** Separate EO transport: no context assembly, provider routing, ordinary projects or model chat. */
export async function executeExecutiveCommand(payload:Command,request:NextRequest){
 const requestId=request.headers.get('x-request-id')?.trim() || crypto.randomUUID();
 if(!/^[A-Za-z0-9._:-]{1,128}$/.test(requestId))
  return NextResponse.json({error:'Invalid request ID'},{status:400});
 if(!payload.message?.trim())return NextResponse.json({error:'Executive objective is required'},{status:400});
 const {data:chat,error:chatError}=await getSupabaseAdminClient().from('chats')
  .select('actor_id').eq('id',payload.chatId).maybeSingle<{actor_id:string}>();
 if(chatError||chat?.actor_id!==payload.actorId)return NextResponse.json({error:'Executive chat ownership mismatch'},{status:404});
 if(payload.images?.length||payload.fileReferences?.length)
  return NextResponse.json({error:'Executive management cannot silently process attachments. Provide objectives in text, and assign evidence review to an authorized specialist.'},{status:422});
 let result:string;
 try{
  result=await handleExecutiveManagement({...payload,requestId});
  await saveOnce(payload.chatId,replyId(requestId,'user'),'user',payload.message);
  await saveOnce(payload.chatId,replyId(requestId,'assistant'),'assistant',result);
 }catch(error){
  console.error('[Executive] Management dispatch failed',{requestId,error:error instanceof Error?error.message:'unknown'});
  return NextResponse.json({error:'Executive management failed to record or dispatch the assignment. The objective was not accepted as completed.',requestId},{status:503});
 }
 const body=[
  JSON.stringify({type:'metadata',modelId:'executive-manager',provider:'local',requestId,
   explainer:{selected_model:'executive-manager',selected_provider:'local',summary:'Dedicated durable Executive management workflow',selected_source:'executive',fallback_used:false}}),
  JSON.stringify({type:'content',text:result,assets:[],provider:'local',model:'executive-manager'}),''
 ].join('\n');
 return new NextResponse(body,{headers:{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store'}});
}
