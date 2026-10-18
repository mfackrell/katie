import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isTechnicalImageFailure, shouldTryRunpodImage, generateRunpodImage, RUNPOD_IMAGE_MODEL_ID,
} from "../lib/chat/runpod-image-fallback";

const grok = { provider: "grok" as const, error: "xAI request timed out" };
const google = { provider: "google" as const, error: "Gemini response HTTP 503 Service Unavailable" };

test("RunPod requires BOTH failed primary image providers, not one", () => {
  assert.equal(shouldTryRunpodImage({failures:[grok,google],enabled:true,hasReferenceImages:false}),true);
  assert.equal(shouldTryRunpodImage({failures:[grok],enabled:true,hasReferenceImages:false}),false);
  assert.equal(shouldTryRunpodImage({failures:[google],enabled:true,hasReferenceImages:false}),false);
  assert.equal(shouldTryRunpodImage({failures:[grok,google],enabled:false,hasReferenceImages:false}),false);
  assert.equal(shouldTryRunpodImage({failures:[grok,google],enabled:true,hasReferenceImages:true}),false);
});

test("Content refusals cannot be routed around via RunPod", () => {
  for (const error of [
    'xAI Images API failed (400 Bad Request): {"code":"imagine:content-moderated"}',
    "Google stopped this response (PROHIBITED_CONTENT)",
    "Google blocked request for SAFETY",
    "Content moderation policy refusal",
    "The model declined this request",
  ]) {
    assert.equal(isTechnicalImageFailure(error), false);
    assert.equal(shouldTryRunpodImage({
      failures:[{provider:"grok",error},google], enabled:true,hasReferenceImages:false,
    }),false);
    assert.equal(shouldTryRunpodImage({
      failures:[grok,{provider:"google",error}], enabled:true,hasReferenceImages:false,
    }),false);
  }
  assert.equal(isTechnicalImageFailure("upstream 429 rate limit"),true);
  assert.equal(shouldTryRunpodImage({failures:[
    {provider:"grok",error:"Empty image output"}, {provider:"google",error:"Output limit reached"},
  ],enabled:true,hasReferenceImages:false}),true);
});

const png="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7pkAAAAASUVORK5CYII=";
const imageUrl="https://image.runpod.ai/sample/output.png";

test("Use RunPod's public FLUX Schnell endpoint; download expiring image and save inline", async () => {
  let requests=0;
  const result=await generateRunpodImage("A lighthouse",{
    apiKey:"test-key",
    fetchFn:(async (url:string|URL|Request,init?:RequestInit)=>{
      requests++;
      if (requests===1) {
        assert.equal(String(url),`https://api.runpod.ai/v2/${RUNPOD_IMAGE_MODEL_ID}/runsync`);
        assert.equal(init?.method,"POST");
        assert.equal((init?.headers as Record<string,string>)?.Authorization,"Bearer test-key");
        assert.deepEqual(JSON.parse(String(init?.body)),{input:{prompt:"A lighthouse",width:1024,height:1024}});
        return new Response(JSON.stringify({status:"COMPLETED",output:{image_url:imageUrl}}),{status:200});
      }
      assert.equal(requests,2);
      assert.equal(String(url),imageUrl);
      assert.equal(init?.method,"GET");
      assert.equal(init?.redirect,"error");
      assert.equal(init?.headers,undefined);
      return new Response(Buffer.from(png,"base64"),{status:200,headers:{"content-type":"image/png"}});
    }) as typeof fetch,
  });
  assert.equal(requests,2);
  assert.equal(result.provider,"runpod");
  assert.equal(result.model,RUNPOD_IMAGE_MODEL_ID);
  assert.equal(result.content?.[0]?.url,"data:image/png;base64,"+png);
});

test("Untrusted image hosts are rejected without downloading",async()=>{
  for(const url of ["https://example.com/output.png","http://image.runpod.ai/output.png","https://image.runpod.ai.evil.com/a","https://user:pw@image.runpod.ai/out.png"]) {
    let requests=0;
    await assert.rejects(generateRunpodImage("lighthouse",{
      apiKey:"test",fetchFn:(async()=>{
        requests++;
        return new Response(JSON.stringify({status:"COMPLETED",output:{image_url:url}}),{status:200});
      }) as typeof fetch,
    }),/untrusted image URL/);
    assert.equal(requests,1,"No untrusted outbound image fetch");
  }
});

test("Reject malformed upstream output and wrong image bytes",async()=>{
  await assert.rejects(generateRunpodImage("lighthouse",{
    apiKey:"test",fetchFn:(async()=>new Response(JSON.stringify({
      status:"COMPLETED",output:{images:[{data:png}]},
    }),{status:200})) as typeof fetch,
  }),/image URL missing/);

  let n=0;
  await assert.rejects(generateRunpodImage("lighthouse",{
    apiKey:"test",fetchFn:(async()=>{
      n++;
      return n===1
        ? new Response(JSON.stringify({status:"COMPLETED",output:{image_url:imageUrl}}),{status:200})
        : new Response("not an image; length exceeds minimum",{status:200});
    }) as typeof fetch,
  }),/unsupported image format/);
});

test("Fallback stays separate from video analysis and requires configured RunPod credentials",()=>{
  const source=readFileSync("app/api/chat/route.ts","utf8");
  assert.match(source,/if \(candidate\.runpodImageFallback\)/);
  assert.match(source,/shouldTryRunpodImage\(\{/);
  assert.match(source,/if \(attempt\.runpodImageFallback\) return null/);
  assert.match(source,/generateRunpodImage\(/);
});
