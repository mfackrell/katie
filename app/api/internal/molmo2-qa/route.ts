import {NextRequest,NextResponse} from "next/server";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;

const API="https://api.runpod.io/v2";
const NAME="katie-molmo2-video-qa-20261010";
const MODEL="allenai/Molmo2-8B";
const PUBLIC_VIDEO="https://storage.googleapis.com/oe-training-public/demo_videos/many_penguins.mp4";
type JsonObject=Record<string,unknown>;
function obj(x:unknown):JsonObject{return x&&typeof x==="object"&&!Array.isArray(x)?x as JsonObject:{};}
function arr(x:unknown):JsonObject[]{return Array.isArray(x)?x.map(obj):[];}
function err(e:unknown){return e instanceof Error?e.name:"unknown_failure";}
function output(value:unknown,status=200){return NextResponse.json(value,{status,headers:{"cache-control":"no-store"}});}
export async function GET(req:NextRequest){
 if(process.env.VERCEL_ENV!=="preview")return output({error:"preview_only"},403);
 const key=process.env.RUNPOD_API_KEY;
 if(!key)return output({error:"runpod_key_unavailable"},503);
 const action=req.nextUrl.searchParams.get("action")||"inspect";
 const headers={Authorization:"Bearer "+key,"content-type":"application/json"};
 async function api(path:string,method="GET",body?:unknown){
  const r=await fetch(API+path,{method,headers, ...(body?{body:JSON.stringify(body)}:{}),cache:"no-store",signal:AbortSignal.timeout(24000)});
  return {ok:r.ok,status:r.status,data:obj(await r.json().catch(()=>({})))};
 }
 try{
  const authenticated=await api("/serverless/yafwsm98e8m9lv");
  if(!authenticated.ok||authenticated.data.id!=="yafwsm98e8m9lv")return output({error:"authentication_failed"},403);
  async function discover(){
   const [e,t]=await Promise.all([api("/serverless"),api("/templates")]);
   if(!e.ok||!t.ok)throw new Error("runpod_discovery_failed");
   const ep=arr(e.data.endpoints).find(x=>x.name===NAME);
   const tp=arr(t.data.templates).find(x=>x.name===NAME);
   return {ep,tp};
  }
  if(action==="provision"||action==="inspect"){
   let {ep,tp}=await discover();
   if(action==="inspect")return output({template_id:tp?.id??null,endpoint_id:ep?.id??null,model:MODEL});
   let createdTemplate=false, createdEndpoint=false;
   if(!tp){
    const original=await api("/templates/ykwdli9yfb");
    if(!original.ok||original.data.image!=="runpod/worker-v1-vllm:v2.27.1")
     return output({error:"source_image_mismatch",http:original.status},409);
    const originalEnv=obj(original.data.env);
    const r=await api("/templates","POST",{
     name:NAME,image:original.data.image,serverless:true,disk:Math.max(30,Number(original.data.disk)||30),
     args:original.data.args??"",env:{...originalEnv,MODEL_NAME:MODEL,MAX_MODEL_LEN:"32768",
       MAX_NUM_SEQS:"1",VLLM_VIDEO_FETCH_TIMEOUT:"180"}
    });
    if(!r.ok)return output({error:"template_create_failed",http:r.status,fields:Object.keys(r.data).slice(0,10),
      message:typeof r.data.message==="string"?r.data.message.slice(0,180):null},502);
    tp=obj(r.data.template??r.data);createdTemplate=true;
   }
   if(typeof tp.id!=="string")return output({error:"template_id_missing"},502);
   if(!ep){
    const r=await api("/serverless","POST",{
     name:NAME,templateId:tp.id,type:"QUEUE",
     gpu:{pools:["ADA_48_PRO","AMPERE_80"],count:1},
     workers:{min:0,max:1},
     scaling:{type:"REQUEST_COUNT",requestCount:1},
     flashboot:"FLASHBOOT"
    });
    if(!r.ok)return output({error:"endpoint_create_failed",http:r.status,
      template_id:tp.id,message:typeof r.data.message==="string"?r.data.message.slice(0,200):null},502);
    ep=obj(r.data.endpoint??r.data);createdEndpoint=true;
   }
   return output({template_id:tp.id,endpoint_id:ep?.id??null,createdTemplate,
     createdEndpoint,model:MODEL,workersMin:obj(ep?.workers).min??0});
  }
  const {ep}=await discover();
  if(typeof ep?.id!=="string")return output({error:"endpoint_not_provisioned"},409);
  const endpoint=ep.id;
  if(action==="details"||action==="fix_boot"){
   const tmpl=await api("/templates/lwdc2qpy4l");
   if(!tmpl.ok)return output({error:"template_lookup_failed",http:tmpl.status},502);
   const config=tmpl.data, env=obj(config.env);
   if(action==="details")return output({template:{id:config.id,name:config.name,image:config.image,
     disk:config.disk,env:Object.fromEntries(Object.entries(env).filter(([k])=>
       ["MODEL_NAME","MAX_MODEL_LEN","MAX_NUM_SEQS","GPU_MEMORY_UTILIZATION",
         "SAFETENSORS_LOAD_STRATEGY","ENFORCE_EAGER","TRUST_REMOTE_CODE"].includes(k)))},
     endpoint:{id:ep.id,templateId:ep.templateId,flashboot:ep.flashboot,
       workers:ep.workers,gpu:ep.gpu,scaling:ep.scaling}});
   if(config.id!=="lwdc2qpy4l"||config.name!==NAME||
      env.MODEL_NAME!==MODEL||ep.id!=="t52dzwlfimvchg"||(ep.templateId&&ep.templateId!==config.id))
      return output({error:"unexpected_template_or_endpoint"},409);
   const newEnv:JsonObject={...env,MAX_MODEL_LEN:"4096",MAX_NUM_SEQS:"1",
      GPU_MEMORY_UTILIZATION:"0.85",ENFORCE_EAGER:"true",TRUST_REMOTE_CODE:"true"};
   delete newEnv.SAFETENSORS_LOAD_STRATEGY;
   const patch=await api("/templates/lwdc2qpy4l","PATCH",
      {disk:100,env:newEnv});
   const saved=obj(patch.data);
   return output({http:patch.status,updated:patch.ok,template_id:saved.id??null,
     disk:saved.disk??null,env:Object.fromEntries(Object.entries(obj(saved.env))
       .filter(([k])=>["MODEL_NAME","MAX_MODEL_LEN","MAX_NUM_SEQS","GPU_MEMORY_UTILIZATION",
       "ENFORCE_EAGER","TRUST_REMOTE_CODE"].includes(k)))},patch.ok?200:502);
  }
  if(action==="force_trust"){
   if(ep.id!=="t52dzwlfimvchg"||ep.name!==NAME)return output({error:"endpoint_mismatch"},409);
   const t=await api("/templates/lwdc2qpy4l");
   if(!t.ok||t.data.id!=="lwdc2qpy4l"||obj(t.data.env).MODEL_NAME!==MODEL)
    return output({error:"template_verification_failed"},409);
   const env={...obj(t.data.env),TRUST_REMOTE_CODE:"true",VLLM_EXTRA_ARGS:"--trust-remote-code"};
   const changed=await api("/templates/lwdc2qpy4l","PATCH",{env});
   if(!changed.ok)return output({error:"template_update_failed",http:changed.status},502);
   const released=await api("/serverless/"+endpoint,"PATCH",{templateId:"lwdc2qpy4l"});
   return output({action,templateUpdated:changed.ok,endpointUpdated:released.ok,
    endpointHttp:released.status,trustRemoteCode:obj(changed.data.env).TRUST_REMOTE_CODE=== "true",
    explicitCliFlag:obj(changed.data.env).VLLM_EXTRA_ARGS=== "--trust-remote-code"},released.ok?200:502);
  }
  if(action==="apply_release"){
   if(ep.id!=="t52dzwlfimvchg"||ep.name!==NAME)return output({error:"endpoint_mismatch"},409);
   const t=await api("/templates/lwdc2qpy4l");
   if(!t.ok||obj(t.data.env).TRUST_REMOTE_CODE!=="true")
    return output({error:"trust_remote_code_not_configured"},409);
   const r=await api("/serverless/"+endpoint,"PATCH",{templateId:"lwdc2qpy4l"});
   return output({action,http:r.status,endpoint_id:r.data.id??null,
    template_id:r.data.templateId??obj(r.data.template).id??null,
    version:r.data.version??null,workers:r.data.workers??null},r.ok?200:502);
  }
  if(action==="pause_workers"||action==="resume_workers"){
   if(ep.id!=="t52dzwlfimvchg"||ep.name!==NAME)return output({error:"endpoint_mismatch"},409);
   const payload=action==="pause_workers"?{workersMax:0}:{workersMax:1,flashboot:false};
   const u=await fetch("https://rest.runpod.io/v1/endpoints/"+endpoint,{
    method:"PATCH",headers,body:JSON.stringify(payload),
    signal:AbortSignal.timeout(18000)});
   const data=obj(await u.json().catch(()=>({})));
   return output({action,http:u.status,endpoint_id:data.id??null,
     workersMax:data.workersMax??null,flashboot:data.flashboot??null},u.ok?200:502);
  }
  if(action==="worker_logs"){
   const worker=req.nextUrl.searchParams.get("worker")||"";
   if(!/^[a-z0-9]{6,25}$/.test(worker))return output({error:"invalid_worker"},400);
   const source=req.nextUrl.searchParams.get("source")||"container";
   if(!["container","system","all"].includes(source))return output({error:"bad_source"},400);
   const url=API+"/serverless/"+endpoint+"/workers/"+worker+"/logs?tail=30"+
     (source==="all"?"":"&source="+source);
   const ctrl=new AbortController();
   const timeout=setTimeout(()=>ctrl.abort(),7000);
   try {
    const r=await fetch(url,{headers,cache:"no-store",signal:ctrl.signal});
    let raw="";
    if(r.body){
     const reader=r.body.getReader();
     const dec=new TextDecoder();
     while(raw.length<18000){
      let block:ReadableStreamReadResult<Uint8Array>;
      try {block=await reader.read();}catch{break;}
      if(block.done)break;
      raw+=dec.decode(block.value,{stream:true});
     }
     await reader.cancel().catch(()=>{});
    }
    const sanitized=raw.replace(new RegExp("https?://[^\\\\s]+","gi"),"[url]")
      .replace(new RegExp("Bearer\\\\s+\\\\S+","gi"),"Bearer [redacted]");
    return output({worker,http:r.status,log:sanitized.slice(-12000)});
   }catch(e){return output({worker,error:err(e)},502);}
   finally{clearTimeout(timeout);}

  }
  if(action==="workers"){
   const r=await api("/serverless/"+endpoint+"/workers");
   const items=arr(r.data.workers).map(w=>({
      id:w.id??null,status:w.status??null,version:w.version??null,
      startedAt:w.startedAt??null,uptimeSeconds:w.uptimeSeconds??null,
      errorCode:w.errorCode??null
   }));
   return output({http:r.status,endpoint,count:items.length,summary:r.data.summary??null,workers:items},r.ok?200:502);
  }
  if(action==="submit"){
   const payload={input:{route:"/v1/chat/completions",method:"POST",body:{
    model:MODEL,temperature:0,max_tokens:450,messages:[{role:"user",content:[
     {type:"video_url",video_url:{url:PUBLIC_VIDEO}},
     {type:"text",text:"Provide a detailed and specific description of the video"}
    ]}]
   }}};
   const r=await fetch("https://api.runpod.ai/v2/"+endpoint+"/run",{
    method:"POST",headers,body:JSON.stringify(payload),signal:AbortSignal.timeout(23000)});
   const d=obj(await r.json().catch(()=>({})));
   return output({http:r.status,jobId:d.id??null,state:d.status??null,endpoint,
     model:MODEL,prompt:"Provide a detailed and specific description of the video",testVideo:"Ai2 public penguins example"},r.ok?200:502);
  }
  if(action==="status"){
   const id=req.nextUrl.searchParams.get("job")||"";
   if(!/^[a-zA-Z0-9-]{12,160}$/.test(id))return output({error:"invalid_job"},400);
   const r=await fetch("https://api.runpod.ai/v2/"+endpoint+"/status/"+id,{
    headers,cache:"no-store",signal:AbortSignal.timeout(20000)});
   const d=obj(await r.json().catch(()=>({})));
   const o=obj(Array.isArray(d.output)?d.output[0]:d.output);
   const choices=arr(o.choices);
   const content=obj(choices[0]?.message).content;
   const errorData=obj(d.error);
   return output({http:r.status,jobId:d.id??null,status:d.status??null,
     delayTime:d.delayTime??null,executionTime:d.executionTime??null,
     textLength:typeof content==="string"?content.length:0,
     output:typeof content==="string"?content.slice(0,6000):null,
     finishReason:choices[0]?.finish_reason??null,
     errorType:typeof errorData.type==="string"?errorData.type:null},r.ok?200:502);
  }
  if(action==="health"){
   const r=await fetch("https://api.runpod.ai/v2/"+endpoint+"/health",{headers,cache:"no-store",signal:AbortSignal.timeout(12000)});
   const d=obj(await r.json().catch(()=>({})));
   return output({http:r.status,workers:d.workers??null,jobs:d.jobs??null});
  }
  return output({error:"unknown_action"},400);
 }catch(e){return output({error:err(e)},502);}
}
