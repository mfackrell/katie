import test from "node:test";
import assert from "node:assert/strict";
import { createWebsiteEvidenceStore } from "../lib/research/stored-evidence";
import type { ResearchEvidenceBundle } from "../lib/providers/types";
const actor = "11111111-1111-4111-8111-111111111111", chat = "22222222-2222-4222-8222-222222222222", request = "33333333-3333-4333-8333-333333333333";
const evidence: ResearchEvidenceBundle = { kind:"web", retrievedBy:{provider:"grok",modelId:"grok-4.7"},query:"Review https://example.com",retrievedAt:"2026-10-02T15:00:00Z",summary:"The hero says Acme. Blue button.",sources:[{url:"https://example.com"}],website:{capturedAt:"2026-10-02T15:00:00Z",limitations:["First 4500 pixels only"],pages:[{url:"https://example.com",requestedUrl:"https://example.com",title:"Acme",html:"<h1>Acme</h1>",htmlTruncated:false,stylesheets:[],limitations:[],views:[{device:"desktop",viewport:{width:1440,height:900},document:{width:1440,height:6000,horizontalOverflow:false},text:"Acme",elements:[],images:[],limitations:[],screenshot:{dataUrl:"data:image/png;base64,AAA",width:1440,height:4500,truncated:true}}]}]}};
function fixture() {
 const files = new Map<string,string>(); const downloads:string[]=[];
 const storage:any = {getBucket:async()=>({data:{public:false},error:null}),from:()=>({upload:async(p:string,s:string)=>{files.set(p,s);return {error:null}},list:async(p:string)=>({data:[...files.keys()].filter(k=>k.startsWith(p+'/')).map(k=>({name:k.slice(p.length+1)})),error:null}),download:async(p:string)=>{downloads.push(p);return files.has(p)?{data:new Blob([files.get(p)!]),error:null}:{error:{message:"missing"}};}})};
 return {store:createWebsiteEvidenceStore(storage),files,downloads};
}
test("website source survives a separate turn; summary identifies real prior inspection",async()=>{
 const f=fixture(); await f.store.save(actor,chat,request,evidence);
 const r=await f.store.restore(actor,chat,"you are too focused on the website",[]);
 assert.match(r.context,/recorded earlier inspection/); assert.match(r.context,/Acme/); assert.match(r.context,/4500/); assert.equal(r.images.length,0);
 assert.equal(f.downloads.filter(p=>!p.endsWith('.summary.json')).length,0);
});
test("detailed follow-up reopens exact HTML and screenshot; refresh uses historical summary only",async()=>{
 const f=fixture(); await f.store.save(actor,chat,request,evidence);
 const r=await f.store.restore(actor,chat,"What is the exact headline and button color?",[]);
 assert.match(r.context,/<h1>Acme/); assert.equal(r.images[0],"data:image/png;base64,AAA");
 const fresh=await f.store.restore(actor,chat,"Review the site again",[]);
 assert.equal(fresh.fresh,true);assert.deepEqual(fresh.targetUrls,["https://example.com"]);assert.equal(fresh.images.length,0);assert.match(fresh.context,/historical comparison only/);
});
test("unrelated topics, different websites and different actors do not receive stored evidence",async()=>{
 const f=fixture(); await f.store.save(actor,chat,request,evidence);
 for(const [a,msg] of [[actor,"What is 2 plus 2?"],[actor,"Review https://other.example"],[request,"Review the site"]])assert.equal((await f.store.restore(a,chat,msg,[])).context,"");
});
test("missing source is reported instead of manufacturing a full inspection",async()=>{
 const f=fixture(); await f.store.save(actor,chat,request,evidence);
 for(const k of f.files.keys())if(!k.endsWith('.summary.json'))f.files.delete(k);
 await assert.rejects(f.store.restore(actor,chat,"Show the screenshot",[]),/unavailable/);
});

test("text-only website research is retained with explicit visual coverage limits",async()=>{
 const f=fixture(); await f.store.save(actor,chat,request,{...evidence,website:undefined});
 const r=await f.store.restore(actor,chat,"What did the website say?",[]);
 assert.match(r.context,/Acme/);assert.match(r.context,/no rendered screenshots/);assert.equal(r.images.length,0);
});
