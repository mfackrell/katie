import {NextRequest,NextResponse} from "next/server";
export const runtime="nodejs";export const dynamic="force-dynamic";export const maxDuration=50;
const ID="yafwsm98e8m9lv";
const FIELDS=["id","name","workersMin","workersMax","idleTimeout","scalerType","scalerValue","flashBootType","gpuTypeIds","gpuIds","gpuCount","networkVolumeId","templateId","activeWorkers","maxWorkers","gpuType","type","locations","gpuPoolIds","scaling","flashboot","workersStandby"];
function clean(d:unknown){
 if(!d||typeof d!=="object")return null;
 const x=d as Record<string,unknown>, out:Record<string,unknown>={};
 for(const k of FIELDS)if(k in x)out[k]=x[k];
 for(const k of ["workers","gpu","flashboot","networkVolume","endpoint"])if(x[k]&&typeof x[k]==="object"){
 const v=x[k] as Record<string,unknown>, small:Record<string,unknown>={};
 for(const s of ["min","max","idleTimeout","count","pools","excludedTypes","type","queueDelay","requestCount","id","size","flashboot"])if(s in v)small[s]=v[s];
 out[k]=small;
 }
 return out;
}
async function read(url:string,key:string){
 const r=await fetch(url,{headers:{Authorization:"Bearer "+key},cache:"no-store",signal:AbortSignal.timeout(12000)});
 const d=await r.json().catch(()=>({}));
 return {http:r.status,data:clean(d),topLevelKeys:d&&typeof d==="object"?Object.keys(d).filter(k=>!/env|secret|key|token/i.test(k)).slice(0,35):[]};
}
export async function GET(request:NextRequest){
 if(process.env.VERCEL_ENV!=="preview")return NextResponse.json({error:"preview_only"},{status:403});
 const key=process.env.RUNPOD_API_KEY;if(!key)return NextResponse.json({error:"key_unavailable"},{status:503});
 const action=request.nextUrl.searchParams.get("action")||"inspect";
 try{
 if(action==="inspect"){
 const [v1,v2,health]=await Promise.all([
 read("https://rest.runpod.io/v1/endpoints/"+ID,key),
 read("https://api.runpod.io/v2/serverless/"+ID,key),
 read("https://api.runpod.ai/v2/"+ID+"/health",key)
 ]);
 return NextResponse.json({action,v1,v2,health:{http:health.http,data:health.data}});
 }
 if(action==="template_tune"){
  const url="https://api.runpod.io/v2/templates/ykwdli9yfb";
  const r=await fetch(url,{headers:{Authorization:"Bearer "+key},cache:"no-store",signal:AbortSignal.timeout(12000)});
  if(!r.ok)return NextResponse.json({error:"template_read_failed",code:r.status},{status:502});
  const d=await r.json();const env=d?.env&&typeof d.env==="object"?d.env:{};
  if(env["MODEL_NAME"]!=="Qwen/Qwen3-VL-8B-Instruct"||env["MAX_NUM_SEQS"]!=="1")
    return NextResponse.json({error:"unexpected_existing_template"},{status:409});
  const next={...env,SAFETENSORS_LOAD_STRATEGY:"prefetch"};
  const patch=await fetch(url,{method:"PATCH",headers:{Authorization:"Bearer "+key,"content-type":"application/json"},
   body:JSON.stringify({env:next}),signal:AbortSignal.timeout(16000)});
  const result=await patch.json().catch(()=>({}));
  const safe=result.env&&typeof result.env==="object"?Object.fromEntries(Object.entries(result.env)
   .filter(([k])=>["SAFETENSORS_LOAD_STRATEGY","MAX_NUM_SEQS","MAX_MODEL_LEN","MODEL_NAME"].includes(k))):null;
  return NextResponse.json({action,http:patch.status,requestedEnvNames:Object.keys(next),
   confirmedEnv:safe,errorMessage:typeof result.message==="string"?result.message.slice(0,180):null},
    {status:patch.ok?200:502});
 }
 if(action==="workers"){
  const r=await fetch("https://api.runpod.io/v2/serverless/"+ID+"/workers",{
   headers:{Authorization:"Bearer "+key},cache:"no-store",signal:AbortSignal.timeout(15000)
  });
  const d=await r.json().catch(()=>({}));const list=Array.isArray(d?.workers)?d.workers:[];
  const cleaned=list.map((w:Record<string,unknown>)=>{
   const o:Record<string,unknown>={};for(const k of ["id","workerId","status","desiredStatus","createdAt",
   "startedAt","updatedAt","uptimeSeconds","workerState","exitCode","errorCode","isReady","version"])
     if(w[k]!==undefined)o[k]=w[k];return o;
  });
  return NextResponse.json({action,http:r.status,summary:d?.summary??null,count:cleaned.length,workers:cleaned});
 }
 if(action==="template"){
  const url="https://api.runpod.io/v2/templates/ykwdli9yfb";
  const r=await fetch(url,{headers:{Authorization:"Bearer "+key},cache:"no-store",signal:AbortSignal.timeout(14000)});
  const d=await r.json().catch(()=>({}));
  const env=(d?.env&&typeof d.env==="object")?d.env:{};
  return NextResponse.json({action,http:r.status,id:d.id??null,name:d.name??null,imageName:d.imageName??d.image??null,templateKeys:d&&typeof d==="object"?Object.keys(d).filter(k=>!/token|secret|key|env/i.test(k)):[],args:d.args??null,
   envNames:Object.keys(env),safeEnv:Object.fromEntries(Object.entries(env).filter(([k])=>
    ["MODEL_NAME","MODEL_ID","MAX_NUM_SEQS","COMPILATION_CONFIG","SAFETENSORS_LOAD_STRATEGY","VLLM_CACHE_ROOT",
      "GPU_MEMORY_UTILIZATION","TENSOR_PARALLEL_SIZE","MAX_MODEL_LEN","HF_HUB_OFFLINE"].includes(k))),
   containerDiskInGb:d.containerDiskInGb??null,volumeInGb:d.volumeInGb??null
  });
 }
 if(action==="tune"){
  const patch={scalerType:"REQUEST_COUNT",scalerValue:1,idleTimeout:300,flashboot:true};
  const r=await fetch("https://rest.runpod.io/v1/endpoints/"+ID,{
    method:"PATCH",headers:{Authorization:"Bearer "+key,"content-type":"application/json"},
    body:JSON.stringify(patch),signal:AbortSignal.timeout(18000)
  });
  const data=await r.json().catch(()=>({}));
  return NextResponse.json({action,http:r.status,sent:patch,response:clean(data),
    errors:Array.isArray(data?.errors)?data.errors.map((x:unknown)=>String(x).slice(0,150)):null});
 }
 if(action==="benchmark"){
 const now=Date.now();
 const body={input:{route:"/v1/chat/completions",method:"POST",body:{
 model:"Qwen/Qwen3-VL-8B-Instruct",max_tokens:32,temperature:0,
 messages:[{role:"user",content:"Reply with exactly: warm worker validation"}]
 }}};
 const r=await fetch("https://api.runpod.ai/v2/"+ID+"/run",{
 method:"POST",headers:{"Authorization":"Bearer "+key,"content-type":"application/json"},
 body:JSON.stringify(body),signal:AbortSignal.timeout(18000)
 });
 const data=await r.json().catch(()=>({}));
 return NextResponse.json({action,http:r.status,id:data.id||null,status:data.status||null,submittedAt:now});
 }
 if(action==="job"){
 const id=request.nextUrl.searchParams.get("id")||"";
 if(!/^[a-zA-Z0-9-]{10,150}$/.test(id))return NextResponse.json({error:"bad_job"}, {status:400});
 const r=await fetch("https://api.runpod.ai/v2/"+ID+"/status/"+id,{headers:{Authorization:"Bearer "+key},cache:"no-store",signal:AbortSignal.timeout(15000)});
 const d=await r.json().catch(()=>({}));
 return NextResponse.json({http:r.status,id:d.id??null,status:d.status??null,delayTime:d.delayTime??null,executionTime:d.executionTime??null,outputPresent:Boolean(d.output),errorCode:d.error?.code??null});
 }
 return NextResponse.json({error:"unknown_action"},{status:400});
 }catch(e){return NextResponse.json({error:e instanceof Error?e.name:"unexpected"},{status:502});}
}