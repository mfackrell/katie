import test, { afterEach, beforeEach, describe, mock } from "node:test";
import * as unsupported from "../lib/standalone-accounting/unsupported";
import assert from "node:assert/strict";
import { describeImageWithRunpodQwen } from "../lib/chat/runpod-still-vision";

describe("RunPod still-image protocol", () => {
  // Protocol fixtures use fake HTTP only. Production admission is exercised
  // separately with the real, unmocked guard in standalone-unpriced-dispatch.
  beforeEach(() => { mock.method(unsupported, "blockUnaccountedPaidDispatch", () => {}); });
  afterEach(() => { mock.restoreAll(); });

test("RunPod Qwen still-image fallback submits pixels once and polls the same job",async()=>{
 const prior=process.env.RUNPOD_API_KEY;
 process.env.RUNPOD_API_KEY="fixture-key";
 const urls:string[]=[];
 try{
   const result=await describeImageWithRunpodQwen("data:image/jpeg;base64,QUJDRA==","Describe photo",{
     fetchFn:async (input, init)=>{
       const url=String(input);urls.push(url);
       if(url.endsWith("/run")){
         assert.equal(init?.method,"POST");
         const body=JSON.parse(String(init?.body)) as {
           input:{body:{messages:Array<{content:Array<{type:string;image_url?:{url:string}}>} >}}
         };
         const parts=body.input.body.messages[0].content;
         assert.equal(parts[0].type,"image_url");
         assert.equal(parts[0].image_url?.url,"data:image/jpeg;base64,QUJDRA==");
         return Response.json({id:"job-accepted-123",status:"IN_QUEUE"});
       }
       assert.match(url,/\/status\/job-accepted-123$/);
       return Response.json({id:"job-accepted-123",status:"COMPLETED",output:{
         choices:[{message:{role:"assistant",content:"A brown dog in a room."}}],
         usage:{prompt_tokens:100,completion_tokens:10}
       }});
     },
     sleep:async()=>{},
   });
   assert.equal(result.text,"A brown dog in a room.");
   assert.match(result.model,/runpod:Qwen/);
   assert.equal(urls.filter(url=>url.endsWith("/run")).length,1);
   assert.equal(urls.length,2);
 }finally{
   if(prior===undefined)delete process.env.RUNPOD_API_KEY;
   else process.env.RUNPOD_API_KEY=prior;
 }
});
test("RunPod refuses invalid pixels before any paid call",async()=>{
 let calls=0;
 await assert.rejects(describeImageWithRunpodQwen("data:text/plain;base64,SGk=","describe",{
   fetchFn:async()=>{calls++;throw Error("Unexpected inference");}
 }),/requires one bounded/);
 assert.equal(calls,0);
});

});
