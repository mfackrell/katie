import { blockUnaccountedPaidDispatch } from "@/lib/standalone-accounting/unsupported";
import { RUNPOD_VIDEO_ENDPOINT_ID, RUNPOD_VIDEO_MODEL, parseRunpodOutput, requireRunpodKey } from "@/lib/runpod/durable-results";

const JOB_ID = /^[A-Za-z0-9-]{8,150}$/;
const MAX_IMAGE_LENGTH = 8_000_000;
const MAX_POLL_MS = 90_000;
const POLL_MS = 2500;
type Job = { id?: string; status?: string; output?: unknown; error?: unknown };
type Dependencies = {
  fetchFn?: typeof fetch;
  sleep?: (ms:number)=>Promise<void>;
  now?: ()=>number;
};

/** One charged Qwen3-VL still-image analysis after an eligible Grok failure.
 * This reuses Katie's verified Qwen RunPod endpoint and its OpenAI-compatible
 * queued chat-completion contract, but sends image_url rather than video_url.
 * A submitted job is only polled, never submitted twice. */
export async function describeImageWithRunpodQwen(
  imageDataUrl:string,
  question:string,
  deps:Dependencies={}
):Promise<{text:string;model:string}>{
  if (!/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(imageDataUrl) ||
      imageDataUrl.length > MAX_IMAGE_LENGTH)
    throw new Error("RunPod still-image analysis requires one bounded JPEG, PNG or WebP.");
  const apiKey=requireRunpodKey();
  const fetchFn=deps.fetchFn??fetch;
  const sleep=deps.sleep??(ms=>new Promise<void>(resolve=>setTimeout(resolve,ms)));
  const now=deps.now??Date.now;
  const userPrompt=question.trim().slice(0,1800) || "Describe the visible contents of this uploaded photograph factually.";
  blockUnaccountedPaidDispatch("RunPod still-image analysis");
  const submitted=await fetchFn("https://api.runpod.ai/v2/"+RUNPOD_VIDEO_ENDPOINT_ID+"/run",{
    method:"POST",
    headers:{Authorization:"Bearer "+apiKey,"Content-Type":"application/json",Accept:"application/json"},
    cache:"no-store",redirect:"error",
    signal:AbortSignal.timeout(25_000),
    body:JSON.stringify({input:{
      route:"/v1/chat/completions",method:"POST",
      body:{model:RUNPOD_VIDEO_MODEL,temperature:0,max_tokens:1400,messages:[{
        role:"user",content:[
          {type:"image_url",image_url:{url:imageDataUrl}},
          {type:"text",text:userPrompt}
        ]
      }]}
    }})
  });
  if (!submitted.ok) throw new Error("RunPod still-image submission rejected (HTTP "+submitted.status+").");
  const initial=await submitted.json() as Job;
  if (typeof initial.id!=="string"||!JOB_ID.test(initial.id))
    throw new Error("RunPod still-image submission returned no valid job identity.");
  const jobId=initial.id;
  let job=initial;
  const deadline=now()+MAX_POLL_MS;
  while(job.status==="IN_QUEUE"||job.status==="IN_PROGRESS"){
    if(now()+POLL_MS>=deadline)throw new Error("RunPod still-image analysis timed out; accepted job was not resubmitted.");
    await sleep(POLL_MS);
    const status=await fetchFn("https://api.runpod.ai/v2/"+RUNPOD_VIDEO_ENDPOINT_ID+"/status/"+jobId,{
      method:"GET",
      headers:{Authorization:"Bearer "+apiKey,Accept:"application/json"},
      cache:"no-store",redirect:"error",signal:AbortSignal.timeout(18_000)
    });
    if(!status.ok)throw new Error("RunPod still-image status unavailable (HTTP "+status.status+").");
    const next=await status.json() as Job;
    if(next.id!==undefined&&next.id!==jobId)throw new Error("RunPod still-image job identity changed.");
    job={...next,id:jobId};
  }
  if(job.status!=="COMPLETED")throw new Error("RunPod still-image inference ended without completion.");
  const parsed=parseRunpodOutput(job as Record<string,unknown>);
  if(parsed.status!=="completed"||!parsed.analysis_text)throw new Error("RunPod completed without a usable image description.");
  return {text:parsed.analysis_text,model:"runpod:"+RUNPOD_VIDEO_MODEL};
}
