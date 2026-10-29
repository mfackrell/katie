import test from "node:test";
import assert from "node:assert/strict";
import { createWebsiteEvidenceStore } from "../lib/research/stored-evidence";
import type { ResearchEvidenceBundle } from "../lib/providers/types";
const actor = "11111111-1111-4111-8111-111111111111", chat = "22222222-2222-4222-8222-222222222222", request = "33333333-3333-4333-8333-333333333333";
const siteHistory=[{role:'user',content:'Review https://example.com'},{role:'assistant',content:'I reviewed the website.'}];
const evidence: ResearchEvidenceBundle = { kind:"web", retrievedBy:{provider:"grok",modelId:"grok-4.7"},query:"Review https://example.com",retrievedAt:"2026-10-02T15:00:00Z",summary:"The hero says Acme. Blue button.",sources:[{url:"https://example.com"}],website:{capturedAt:"2026-10-02T15:00:00Z",limitations:["First 4500 pixels only"],pages:[{url:"https://example.com",requestedUrl:"https://example.com",title:"Acme",html:"<h1>Acme</h1>",htmlTruncated:false,stylesheets:[],limitations:[],views:[{device:"desktop",viewport:{width:1440,height:900},document:{width:1440,height:6000,horizontalOverflow:false},text:"Acme",elements:[],images:[],limitations:[],screenshot:{dataUrl:"data:image/png;base64,AAA",width:1440,height:4500,truncated:true}}]}]}};
function fixture() {
 const files = new Map<string,string>(); const downloads:string[]=[];
 const storage:any = {getBucket:async()=>({data:{public:false},error:null}),from:()=>({upload:async(p:string,s:string)=>{files.set(p,s);return {error:null}},list:async(p:string)=>({data:[...files.keys()].filter(k=>k.startsWith(p+'/')).map(k=>({name:k.slice(p.length+1)})),error:null}),download:async(p:string)=>{downloads.push(p);return files.has(p)?{data:new Blob([files.get(p)!]),error:null}:{error:{message:"missing"}};}})};
 return {store:createWebsiteEvidenceStore(storage),files,downloads};
}
test("website source survives a separate turn; summary identifies real prior inspection",async()=>{
 const f=fixture(); await f.store.save(actor,chat,request,evidence);
 const r=await f.store.restore(actor,chat,"you are too focused on the website",siteHistory);
 assert.match(r.context,/recorded earlier inspection/); assert.match(r.context,/"renderedPages":1/); assert.match(r.context,/"screenshots":1/); assert.match(r.context,/grok:grok-4.7/); assert.match(r.context,/Acme/); assert.match(r.context,/4500/); assert.equal(r.images.length,0);
 assert.equal(f.downloads.filter(p=>!p.endsWith('.summary.json')).length,0);
});
test("bound detailed follow-up reopens HTML; screenshots require explicit visual reread and refresh uses historical text",async()=>{
 const f=fixture(); await f.store.save(actor,chat,request,evidence);
 const r=await f.store.restore(actor,chat,"What is the exact headline and button color?",siteHistory);
 assert.match(r.context,/<h1>Acme/); assert.deepEqual(r.images,[]);
 const visuals=await f.store.restore(actor,chat,'Reopen the saved website screenshot from https://example.com',[]);
 assert.equal(visuals.images[0],'data:image/png;base64,AAA');
 const fresh=await f.store.restore(actor,chat,"Review the site again",siteHistory);
 assert.equal(fresh.fresh,true);assert.deepEqual(fresh.targetUrls,["https://example.com"]);assert.equal(fresh.images.length,0);assert.match(fresh.context,/historical comparison only/);
});
test("unrelated topics, different websites and different actors do not receive stored evidence",async()=>{
 const f=fixture(); await f.store.save(actor,chat,request,evidence);
 for(const [a,msg] of [[actor,"What is 2 plus 2?"],[actor,"Review https://other.example"],[request,"Review the site"]])assert.equal((await f.store.restore(a,chat,msg,[])).context,"");
});
test("missing source is reported instead of manufacturing a full inspection",async()=>{
 const f=fixture(); await f.store.save(actor,chat,request,evidence);
 for(const k of f.files.keys())if(!k.endsWith('.summary.json'))f.files.delete(k);
 await assert.rejects(f.store.restore(actor,chat,"Show the saved website screenshot from https://example.com",[]),/unavailable/);
});

test("text-only website research is retained with explicit visual coverage limits",async()=>{
 const f=fixture(); await f.store.save(actor,chat,request,{...evidence,website:undefined});
 const r=await f.store.restore(actor,chat,"What did the website say?",siteHistory);
 assert.match(r.context,/Acme/);assert.match(r.context,/no rendered screenshots/);assert.equal(r.images.length,0);
});

test("fresh comparison supplies omitted historical page facts without attaching old screenshot bytes", async () => {
 const f=fixture(); const prior=structuredClone(evidence);
 prior.summary="A short summary that omits the icon and translations.";
 prior.website!.pages[0].html='<svg id="book-icon"></svg><h1>Acme</h1><p lang="fr">Texte français existant</p>';
 await f.store.save(actor,chat,request,prior);
 const fresh=await f.store.restore(actor,chat,"Review the website again and compare changes",siteHistory);
 assert.match(fresh.context,/HISTORICAL_WEBSITE_COMPARISON_BASELINE/);
 assert.match(fresh.context,/book-icon/);
 assert.match(fresh.context,/Texte français existant/);
 assert.match(fresh.context,/cannot be called newly added/);
 assert.equal(fresh.context.includes("data:image/png;base64,AAA"),false);
 assert.deepEqual(fresh.images,[]);
 assert.deepEqual(fresh.previousWebsiteEvidence,prior.website);
});

test('generic photo, image and deictic words never select the newest of sixty saved screenshots',async()=>{
 const f=fixture(),packet=structuredClone(evidence);
 const view=packet.website!.pages[0].views[0];
 packet.website!.pages[0].views=Array.from({length:60},(_,index)=>({...structuredClone(view),screenshot:{...view.screenshot!,dataUrl:`data:image/png;base64,${Buffer.from('saved-'+index).toString('base64')}`}}));
 await f.store.save(actor,chat,request,packet);
 for(const message of ['that','those','earlier','more detail','Describe this image','What about this photo?','Look at that screenshot','Expand on the previous review']){
  const result=await f.store.restore(actor,chat,message,siteHistory,{hasCurrentAttachments:true});
  assert.equal(result.context,'',message);assert.deepEqual(result.images,[],message);assert.deepEqual(result.targetUrls,[],message);
  const withoutUpload=await f.store.restore(actor,chat,message,siteHistory);
  assert.equal(withoutUpload.context,'',message+' without current upload');assert.deepEqual(withoutUpload.images,[]);
 }
 assert.equal(f.downloads.filter(path=>!path.endsWith('.summary.json')).length,0,'generic references never load the full saved packet');
 const currentHeadline=await f.store.restore(actor,chat,'What do you think about the headline in this photo?',siteHistory,{hasCurrentAttachments:true});
 assert.equal(currentHeadline.context,'','current uploaded photo cannot borrow a historical website headline');
 const explicit=await f.store.restore(actor,chat,'Reopen the saved website screenshots from https://example.com',[]);
 assert.equal(explicit.images.length,5,'explicit saved visual reread is bounded independently of packet size');
 assert.match(explicit.context,/At most five/);
 const uploaded=await f.store.restore(actor,chat,'Reopen the saved website screenshots from https://example.com',[],{hasCurrentAttachments:true});
 assert.deepEqual(uploaded.images,[],'saved screenshots cannot silently join current uploaded images');
});

test('explicit saved page reread chooses its exact snapshot and fresh retrieval keeps the current URL',async()=>{
 const f=fixture(),about=structuredClone(evidence),newer=structuredClone(evidence);
 about.summary='Earlier about page';about.website!.pages[0].url='https://example.com/about';about.website!.pages[0].requestedUrl='https://example.com/about';
 newer.summary='Newer homepage';newer.retrievedAt='2026-10-04T15:00:00Z';newer.website!.pages[0].views[0].screenshot!.dataUrl='data:image/png;base64,NEW';
 await f.store.save(actor,chat,request,about);
 await f.store.save(actor,chat,'55555555-5555-4555-8555-555555555555',newer);
 const prior=await f.store.restore(actor,chat,'Reopen the saved website screenshot from https://example.com/about',[]);
 assert.match(prior.context,/Earlier about page/);assert.deepEqual(prior.images,['data:image/png;base64,AAA']);
 const fresh=await f.store.restore(actor,chat,'Review https://example.com/new-page',[]);
 assert.equal(fresh.fresh,true);assert.deepEqual(fresh.targetUrls,['https://example.com/new-page']);assert.deepEqual(fresh.images,[]);
});

test('website context requires a recent bound URL, respects topic changes and never defaults to the latest packet',async()=>{
 const f=fixture();await f.store.save(actor,chat,request,evidence);
 const other={...structuredClone(evidence),retrievedAt:'2026-10-03T15:00:00Z',summary:'Different newer website',sources:[{url:'https://other.example'}],website:undefined,query:'Review https://other.example'};
 await f.store.save(actor,chat,'44444444-4444-4444-8444-444444444444',other);
 assert.equal((await f.store.restore(actor,chat,'What about the website hero?',[])).context,'');
 const bound=await f.store.restore(actor,chat,'What about the website hero?',siteHistory);
 assert.match(bound.context,/Acme/);assert.ok(!bound.context.includes('Different newer website'));
 const unrelated=[...siteHistory,{role:'user',content:'Look at my new profile photo'},{role:'assistant',content:'Here is an opener.'}];
 assert.equal((await f.store.restore(actor,chat,'What about the website headline?',unrelated)).context,'');
 const target=await f.store.restore(actor,chat,'What did https://example.com say?',unrelated);
 assert.match(target.context,/Acme/);
 const ambiguous=[{role:'user',content:'Compare https://example.com and https://other.example'}];
 assert.equal((await f.store.restore(actor,chat,'Expand the website headline',ambiguous)).context,'','two websites do not silently resolve to the most recent one');
});
