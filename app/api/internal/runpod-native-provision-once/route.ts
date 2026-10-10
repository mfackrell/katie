import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// ONE-TIME, IDEMPOTENT provisioner for a SEPARATE RunPod native-video model.
// Restricted to Vercel SSO-protected preview deployments; never merge to main.
// The endpoint scales to zero and is unrelated to Katie's existing fallback.
const TEMPLATE_NAME = "katie-qwen3vl-video-template-20261010";
const ENDPOINT_NAME = "katie-qwen3vl-video-standalone-20261010";
const IMAGE = "runpod/worker-v1-vllm:v2.27.1";
const MODEL = "Qwen/Qwen3-VL-8B-Instruct";
type Json = Record<string, unknown>;

export async function GET() {
  if (process.env.VERCEL_ENV !== "preview")
    return NextResponse.json({error:"preview_only"}, {status:403});
  const key = process.env.RUNPOD_API_KEY;
  if (!key || key.length < 16)
    return NextResponse.json({error:"RunPod key is unavailable"},{status:503});
  const headers = {"Authorization": `Bearer ${key}`, "Content-Type": "application/json"};
  async function api(path:string, method = "GET", body?: Json) {
    const response = await fetch("https://api.runpod.io"+path, {
      method, headers, cache:"no-store", signal:AbortSignal.timeout(45000),
      ...(body ? {body: JSON.stringify(body)} : {})
    });
    const value:unknown = await response.json().catch(()=>({}));
    return {ok:response.ok,status:response.status,
      data:(value && typeof value==="object") ? value as Json : {}};
  }
  try {
    const existing = await api("/v2/serverless");
    if (!existing.ok)
      return NextResponse.json({stage:"list_endpoints",status:existing.status},{status:502});
    const list = (existing.data.endpoints ?? existing.data.items ?? []) as Json[];
    const found = list.find(x=>x.name===ENDPOINT_NAME);
    if (found) return NextResponse.json({
      outcome:"already_provisioned",endpointId:found.id,name:ENDPOINT_NAME,
      templateId:found.templateId,model:MODEL
    });
    const templates = await api("/v2/templates");
    if (!templates.ok)
      return NextResponse.json({stage:"list_templates",status:templates.status},{status:502});
    const saved = (templates.data.templates ?? templates.data.items ?? []) as Json[];
    let templateId = saved.find(x=>x.name===TEMPLATE_NAME)?.id;
    if (!templateId) {
      const created = await api("/v2/templates","POST",{
        name:TEMPLATE_NAME, image:IMAGE, disk:75, serverless:true,
        env: {
          MODEL_NAME: MODEL,
          MAX_MODEL_LEN: "32768",
          MAX_NUM_SEQS: "1",
          GPU_MEMORY_UTILIZATION: "0.90",
          VLLM_WORKER_MULTIPROC_METHOD: "spawn"
        }
      });
      if (!created.ok) return NextResponse.json({
        stage:"create_template",status:created.status,
        errorCode:created.data.code ?? created.data.error ?? created.data.message ?? "api_rejected"
      },{status:502});
      templateId = created.data.id ?? (created.data.template as Json | undefined)?.id;
      if (typeof templateId !== "string") return NextResponse.json({
        stage:"create_template",status:created.status,missingTemplateId:true
      },{status:502});
    }
    const newEndpoint = await api("/v2/serverless","POST",{
      name:ENDPOINT_NAME,
      templateId,
      type:"QUEUE",
      gpu:{pools:["ADA_48_PRO","AMPERE_80"],count:1},
      workers:{min:0,max:1,idleTimeout:60},
      scaling:{type:"QUEUE_DELAY",queueDelay:4},
      flashboot:"OFF",
      timeout:600000
    });
    if (!newEndpoint.ok) return NextResponse.json({
      stage:"create_endpoint", status:newEndpoint.status,
      templateId,
      errorCode:newEndpoint.data.code ?? newEndpoint.data.error ?? newEndpoint.data.message ?? "api_rejected"
    },{status:502});
    const endpointId = newEndpoint.data.id ?? (newEndpoint.data.endpoint as Json | undefined)?.id;
    return NextResponse.json({
      outcome:"provisioned",name:ENDPOINT_NAME,
      endpointId,templateId,model:MODEL,image:IMAGE,
      videoInputType:"video_url",
      gpuPools:["ADA_48_PRO","AMPERE_80"],
      workers:{min:0,max:1},status:newEndpoint.status
    });
  } catch(e) {
    return NextResponse.json({stage:"transport",reason:e instanceof Error?e.name:"network_error"},{status:502});
  }
}
