import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync("lib/chat/one-time-image-replay.ts","utf8");
const cron = readFileSync("app/api/internal/missions/run/route.ts","utf8");

function harness({ responseModel = "gemini-2.5-flash", responseStatus = 200 } = {}) {
  let status="pending", claimCount=0, savedChat, requestPayload, attempts=0;
  const originalChat="00000000-0000-4000-8000-000000000001";
  const actor="00000000-0000-4000-8000-000000000002";
  const attachment="00000000-0000-4000-8000-000000000003";
  const trial={id:"00000000-0000-4000-8000-000000000004",actor_id:actor,source_chat_id:originalChat,
    attachment_id:attachment,replay_chat_id:null,status:"pending",expires_at:"2099-01-01T00:00:00Z"};
  const updates=[];
  const db={from(name){
    assert.equal(name,"image_replay_trials");
    let action="read", payload, filter=[];
    const builder={
      select(){return builder},eq(k,v){filter.push([k,v]);return builder},
      gt(){return builder},order(){return builder},limit(){return builder},
      update(v){action="update";payload=v;return builder},
      async updateReturning(v){
        assert.ok(filter.some(([k,value])=>k==="status"&&value==="pending"));
        if(status!=="pending")return{data:[],error:null};
        status="running";claimCount++;updates.push(v);return{data:[{id:trial.id}],error:null};
      },
      async maybeSingle(){
        if(action==="read")return{data:status==="pending"?trial:null,error:null};
        throw new Error("Claim must use updateReturning");
      },
      then(resolve,reject){
        if(action==="update"){status=payload.status;updates.push(payload);}
        return Promise.resolve({error:null}).then(resolve,reject);
      }
    };
    return builder;
  }};
  const deps={
    "node:crypto":{randomUUID:()=> "10000000-0000-4000-8000-0000000000"+String(++attempts).padStart(2,"0")},
    "next/server":{NextRequest:Request},
    "@/lib/data/supabase/admin":{getSupabaseAdminClient:()=>db},
    "@/lib/data/persistence-store":{
      getChatById:async id=>id===originalChat?{id,actorId:actor}:null,
      getMessages:async id=>id===originalChat
        ?[{role:"user",attachments:[{id:attachment,fileName:"IMG_4449.jpeg",mimeType:"image/jpeg"}]}]
        :[{role:"assistant",content:"A factual description of the photograph.",model:responseModel}],
      saveChat:async chat=>{savedChat=chat;return chat;}
    },
    "@/lib/uploads/stored-uploads":{restoreConversationAttachment:async (_chat,file,owner)=>{
      assert.equal(file.id,attachment);assert.equal(owner,actor);
      return{imageDataUrl:"data:image/jpeg;base64,QUJDRA=="};}},
    "@/app/api/chat/route":{POST:async req=>{requestPayload=JSON.parse(await req.text());
      return new Response("stream consumed",{status:responseStatus});}}
  };
  const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const mod={exports:{}};
  vm.runInNewContext(js,{module:mod,exports:mod.exports,require:id=>{
    if(!(id in deps))throw Error("Unexpected dependency: "+id);
    return deps[id];
  },console:{info(){},error(){}},Date,Response,Request,Promise}, {filename:"one-time-image-replay.js"});
  return{run:mod.exports.runOneSavedImageReplay,trial,actor,originalChat,get status(){return status},
    get claimCount(){return claimCount},get savedChat(){return savedChat},
    get requestPayload(){return requestPayload},updates};
}

test("cron replay remains behind existing cron authorization",()=>{
  assert.match(cron,/if\(!assertCronAuth\(request\)\)return/);
  assert.match(cron,/runOneSavedImageReplay\(\)/);
});

test("single-use replay sends saved JPEG to normal chat and isolates original conversation",async()=>{
  const h=harness();
  const result=await h.run();
  assert.equal(result.status,"completed");
  assert.equal(h.status,"completed");
  assert.equal(h.claimCount,1);
  assert.notEqual(h.savedChat.id,h.originalChat);
  assert.equal(h.savedChat.actorId,h.actor);
  assert.equal(h.requestPayload.message,"[image]");
  assert.equal(h.requestPayload.images[0],"data:image/jpeg;base64,QUJDRA==");
  assert.equal(h.requestPayload.chatId,h.savedChat.id);
  assert.equal(h.updates.at(-1).model,"gemini-2.5-flash");
  assert.equal((await h.run()).status,"idle");
  assert.equal(h.claimCount,1);
});

test("local interception fails replay and does not silently count as visual recognition",async()=>{
  const h=harness({responseModel:"katie-local"});
  assert.equal((await h.run()).status,"failed");
  assert.equal(h.status,"failed");
  assert.match(h.updates.at(-1).error,/intercepted by local response/);
});
