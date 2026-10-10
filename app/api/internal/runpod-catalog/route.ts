import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 50;

// TEMPORARY PREVIEW-ONLY RunPod provisioning catalog check.
export async function GET() {
  if (process.env.VERCEL_ENV !== "preview") return NextResponse.json({error:"preview_only"}, {status:403});
  const key = process.env.RUNPOD_API_KEY;
  if (!key) return NextResponse.json({error:"missing_runpod_key"}, {status:503});
  async function query(path:string) {
    try {
      const res=await fetch("https://api.runpod.io"+path,{headers:{Authorization:`Bearer ${key}`,Accept:"application/json"},signal:AbortSignal.timeout(30000),cache:"no-store"});
      const data=await res.json().catch(()=>({}));
      return {code:res.status,data};
    } catch(err) {return {code:0,error:err instanceof Error?err.name:"network_error"};}
  }
  const [templates,gpus]=await Promise.all([
    query("/v2/templates"),
    query("/v2/catalog/gpus?include=AVAILABILITY&product=SERVERLESS")
  ]);
  const models=Array.isArray(templates.data)?templates.data:templates.data?.items??templates.data?.templates??[];
  const inventory=Array.isArray(gpus.data)?gpus.data:gpus.data?.items??gpus.data?.gpus??[];
  return NextResponse.json({
    templateStatus:templates.code,
    templateCount:models.length,
    templates:models.slice(0,15).map((x:Record<string,unknown>)=>({id:x.id,name:x.name,image:x.image,serverless:x.serverless})),
    gpuStatus:gpus.code,
    gpuCount:inventory.length,
    gpuTypes:inventory.filter((x:Record<string,unknown>)=>/A6000|A40|L40|A100|H100|4090|5090|RTX 6000/i.test(String(x.name||x.displayName||x.id||""))).slice(0,25).map((x:Record<string,unknown>)=>({id:x.id,name:x.name||x.displayName,memory:x.memoryInGb||x.memoryInGB||x.memoryGb}))
  });
}
