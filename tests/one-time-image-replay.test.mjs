import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync("lib/chat/one-time-image-replay.ts","utf8");
const cron = readFileSync("app/api/internal/missions/run/route.ts","utf8");

function harness({ responseModel = "gemini-2.5-flash", responseStatus = 200, venice = false, rejectVenice = false } = {}) {
  let status="pending", claimCount=0, savedChat, requestPayload, attempts=0;
  const originalChat="00000000-0000-4000-8000-000000000001";
  const actor="00000000-0000-4000-8000-000000000002";
  const attachment="00000000-0000-4000-8000-000000000003";
  const owner="00000000-0000-4000-8000-000000000005";
  const image="data:image/jpeg;base64,QUJDRA==";
  const hash=createHash("sha256").update(image).digest("hex");
  let veniceCalls=0,accountingContext=null;
  const messages=[];
  const trial={id:"00000000-0000-4000-8000-000000000004",actor_id:actor,source_chat_id:originalChat,
    attachment_id:attachment,replay_chat_id:null,status:"pending",expires_at:"2099-01-01T00:00:00Z",
    model:venice ? `venice-blind-v1:${owner}:${hash}` : null,
    request_id:venice ? "41c66a47-c074-4c89-9353-615c1db877ad" : null};
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
    "node:crypto":{createHash,randomUUID:()=> "10000000-0000-4000-8000-0000000000"+String(++attempts).padStart(2,"0")},
    "next/server":{NextRequest:Request},
    "@/lib/data/supabase/admin":{getSupabaseAdminClient:()=>db},
    "@/lib/data/persistence-store":{
      getChatById:async id=>id===originalChat?{id,actorId:actor}:savedChat?.id===id?savedChat:null,
      getMessages:async id=>id===originalChat
        ?[{role:"user",attachments:[{id:attachment,fileName:"IMG_4449.jpeg",mimeType:"image/jpeg",observationSourceHash:hash}]}]
        :[{role:"assistant",content:"A factual description of the photograph.",model:responseModel}],
      saveChat:async chat=>{savedChat=chat;return chat;},
      appendUserMessage:async (_chat,m)=>{messages.push({role:"user",...m});return m;},
      appendAssistantMessage:async (_chat,m)=>{messages.push({role:"assistant",...m});return m;}
    },
    "@/lib/standalone-accounting/context":{runWithStandaloneAccounting:(scope,fn)=>{accountingContext=scope;return fn();}},
    "@/lib/standalone-accounting/ledger":{createStandaloneLedger:()=>({authorizeScope:async(o,a,c)=>o===owner&&a===actor&&c===originalChat})},
    "@/lib/chat/venice-still-vision":{describeImageWithVenice:async(imageArg,prompt)=>{
      assert.equal(imageArg,image);assert.match(prompt,/Identify the principal visible subject/i);
      veniceCalls++;
      if(rejectVenice)throw Error("Model unavailable");
      return{text:"The main subject is correctly identified with visible supporting features.",model:"venice:venice-uncensored-1-2",coverage:"full"};
    }},
    "@/lib/uploads/stored-uploads":{restoreConversationAttachment:async (_chat,file,owner)=>{
      assert.equal(file.id,attachment);assert.equal(owner,actor);
      return{imageDataUrl:image};}},
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
    get requestPayload(){return requestPayload},get veniceCalls(){return veniceCalls},
    get accountingContext(){return accountingContext},messages,owner,hash,updates};
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

test("one-time Dolphin replay uses exact saved pixels, approved scope and immutable request once",async()=>{
  const h=harness({venice:true});
  assert.equal((await h.run()).status,"completed");
  assert.equal(h.claimCount,1);
  assert.equal(h.veniceCalls,1);
  assert.equal(h.accountingContext.userId,h.owner);
  assert.equal(h.accountingContext.chatId,h.originalChat);
  assert.equal(h.accountingContext.requestId,"41c66a47-c074-4c89-9353-615c1db877ad");
  assert.notEqual(h.savedChat.id,h.originalChat);
  assert.match(h.savedChat.title,/Dolphin blind image accuracy/);
  assert.equal(h.messages.filter(x=>x.role==="assistant").length,1);
  assert.match(h.messages.find(x=>x.role==="assistant").content,/Exact model response/);
  assert.equal(h.updates.at(-1).model,"venice:venice-uncensored-1-2");
  assert.equal((await h.run()).status,"idle");
  assert.equal(h.veniceCalls,1);
});

test("Dolphin failure is recorded as failed without dispatching a second inference",async()=>{
  const h=harness({venice:true,rejectVenice:true});
  assert.equal((await h.run()).status,"failed");
  assert.equal(h.claimCount,1);
  assert.equal(h.veniceCalls,1);
  assert.match(h.messages.find(x=>x.role==="assistant").content,/not completed/);
  assert.equal((await h.run()).status,"idle");
  assert.equal(h.veniceCalls,1);
});
