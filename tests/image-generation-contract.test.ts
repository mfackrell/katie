import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compactImageGenerationContext } from "../lib/providers/image-generation-context";
import { containsGeneratedImage, imageGenerationCapableModel } from "../lib/chat/image-generation-contract";
import type { ChatGenerateParams } from "../lib/providers/types";

test("image generation retains full user request and references while bounding only background",()=>{
  const history:ChatGenerateParams["history"]=Array.from({length:16},(_,i)=>({
    role:i%2?"assistant":"user",content:"turn-"+i+" "+("saved context ".repeat(400)),
  }));
  history[14]={role:"user",content:"Yesterday you promised to make me a picture of Katie."};
  history[15]={role:"assistant",content:"I will create a visual rather than describing one."};
  const images=["data:image/png;base64,cmVmZXJlbmNl"];
  const attachment={fileId:"fixture",fileName:"reference.png",mimeType:"image/png",preview:"Current reference"};
  const params:ChatGenerateParams={
    name:"Katie",persona:"PERSONA_FIRST "+("immutable identity ".repeat(8000))+" PERSONA_LAST",
    summary:"SUMMARY_FIRST "+("memory entry ".repeat(9000))+" SUMMARY_LATEST",
    history,user:"Surprise me…😉",requestIntent:"image-generation",modelId:"gemini-3.1-flash-image",
    images,attachments:[attachment],
  };
  const compact=compactImageGenerationContext(params);
  assert.notStrictEqual(compact,params);
  assert.equal(compact.user,params.user);
  assert.strictEqual(compact.images,images,"real image bytes/identity anchors are never truncated");
  assert.strictEqual(compact.attachments,params.attachments,"references remain authoritative");
  assert.equal(params.history.length,16,"source conversation must remain intact");
  assert.equal(compact.history.length,8);
  assert.equal(compact.history.at(-2)?.content,"Yesterday you promised to make me a picture of Katie.");
  assert.equal(compact.history.at(-1)?.content,"I will create a visual rather than describing one.");
  assert.ok(compact.persona.startsWith("PERSONA_FIRST"));
  assert.ok(compact.persona.includes("PERSONA_LAST"));
  assert.ok(compact.summary.startsWith("SUMMARY_FIRST"));
  assert.ok(compact.summary.endsWith("SUMMARY_LATEST"));
  assert.match(compact.persona,/IMAGE_OUTPUT_CONTRACT:/);
  const total=compact.persona.length+compact.summary.length+compact.history.reduce((n,t)=>n+t.content.length,0);
  assert.ok(total<35_000,"image background must fit far below the reviewed model context window");
  assert.ok(params.persona.length>100_000,"fixture reproduces oversized background context");
  assert.ok(!params.persona.includes("IMAGE_OUTPUT_CONTRACT"),"source text is not mutated");
});

test("ordinary text generation retains original context unchanged",()=>{
  const params:ChatGenerateParams={name:"Katie",persona:"P".repeat(170000),summary:"summary",history:[],user:"Hello",requestIntent:"general-text"};
  assert.strictEqual(compactImageGenerationContext(params),params);
});

test("image fallback rejects Gemini text and accepts only actual image-generation model families",()=>{
  assert.equal(imageGenerationCapableModel("google","gemini-3.1-flash-image"),true);
  assert.equal(imageGenerationCapableModel("google","models/gemini-3.1-flash-lite-image"),true);
  assert.equal(imageGenerationCapableModel("google","gemini-3.8-flash"),false);
  assert.equal(imageGenerationCapableModel("openai","gpt-image-1.5"),true);
  assert.equal(imageGenerationCapableModel("openai","gpt-5.4-mini"),false);
  assert.equal(imageGenerationCapableModel("grok","grok-imagine-image-2.0"),true);
  assert.equal(imageGenerationCapableModel("anthropic","claude-opus-5-5"),false);
});

test("text-only response never satisfies image delivery even when its wording claims success",()=>{
  assert.equal(containsGeneratedImage({content:undefined}),false);
  assert.equal(containsGeneratedImage({content:[]}),false);
  assert.equal(containsGeneratedImage({content:[{type:"text",url:"[Image Generated]"}]}),false);
  assert.equal(containsGeneratedImage({content:[{type:"image",url:""}]}),false);
  assert.equal(containsGeneratedImage({content:[{type:"image",url:"data:image/png;base64,cmVhbC1iaW5hcnk="}]}),true);
  const route=readFileSync("app/api/chat/route.ts","utf8");
  assert.match(route,/imageGenerationRequested && !candidate\.runpodImageFallback/);
  assert.match(route,/!imageGenerationCapableModel\(candidate\.provider\.name, candidate\.modelId\)/);
  assert.match(route,/imageGenerationRequested && !containsGeneratedImage\(result\)/);
  assert.match(route,/if \(!imageGenerationRequested\) enqueueDelta\(delta\)/);
});
