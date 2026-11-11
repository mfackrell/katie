import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {chromium} from 'playwright-core';
import bundled from '@sparticuz/chromium';
import {modules} from './helpers/load-project-modules.mjs';

const projectId='fe9d2658-41e3-44c1-ae8e-a0cba98371fe';
const releaseSha='06d63710c1caec8d500ce4cad788f8100c8288d9';
const cutoff='2026-11-12T00:00:00Z',priorCutoff='2026-11-10T18:59:32.547837Z';
const now=Date.parse('2026-11-11T14:00:00Z');
const offer={projectId,releaseSha,cutoff,priorCutoff,receipt:null};
const receipt={projectId,missionId:'11111111-1111-4111-8111-111111111111',assignmentId:'22222222-2222-4222-8222-222222222222',cutoff,existing:false};

test('recovery offer is restricted to the authenticated owner project and preserves consumed receipts',async t=>{
 const savedNow=Date.now,savedSha=process.env.VERCEL_GIT_COMMIT_SHA;
 Date.now=()=>now;process.env.VERCEL_GIT_COMMIT_SHA=releaseSha;
 t.after(()=>{Date.now=savedNow;if(savedSha===undefined)delete process.env.VERCEL_GIT_COMMIT_SHA;else process.env.VERCEL_GIT_COMMIT_SHA=savedSha;});
 let owner=true,provider=true,lookup=0,stored=null,lookupError=null;
 let project={id:projectId,status:'blocked',phase:'research',organization_version:1,deadline:priorCutoff};
 const db={from(table){assert.equal(table,'project_director_recoveries');return {
  select(columns){assert.equal(columns,'mission_id,assignment_id,cutoff');return this;},
  eq(column,id){assert.equal(column,'project_id');assert.equal(id,projectId);return this;},
  async maybeSingle(){lookup++;return {data:stored,error:lookupError};},
 };}};
 const actor='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 const loadWithOwner=modules({
  '@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db},
  '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>owner},
  '@/lib/data/persistence-store':{getChatById:async()=>({actorId:actor}),getMessages:async()=>[]},
  '@/lib/projects/store':{projectForChat:async()=>project,projectRpc:async()=>provider},
  '@/lib/projects/recovery-budget':{recoveryResourceProposal:async()=>null},
  '@/lib/executive/delivery':{hasPendingExecutiveDelivery:async()=>false},
 });
 const current=async()=>{
  const request=new Request('https://synthetic.test/api/projects?actorId='+actor+'&chatId=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  request.nextUrl=new URL(request.url);
  return loadWithOwner('@/app/api/projects/route').GET(request);
 };
 assert.deepEqual(JSON.parse(JSON.stringify((await (await current()).json()).directorRecovery)),offer);
 owner=false;assert.equal((await (await current()).json()).directorRecovery,null);owner=true;
 const original=project;
 for(const patch of [{id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'},{phase:'development'},{status:'running'},{deadline:cutoff}]){
  project={...original,...patch};assert.equal((await (await current()).json()).directorRecovery,null);
 }
 project=original;provider=false;assert.equal((await (await current()).json()).directorRecovery,null);provider=true;
 lookupError={message:'state unavailable'};assert.equal((await current()).status,503);lookupError=null;
 stored={mission_id:receipt.missionId,assignment_id:receipt.assignmentId,cutoff};
 const consumed=(await (await current()).json()).directorRecovery;
 assert.deepEqual(consumed.receipt,{...receipt,existing:true});
 project={...original,status:'running',deadline:cutoff};
 assert.deepEqual((await (await current()).json()).directorRecovery.receipt,{...receipt,existing:true},'Admission receipt remains visible during execution');
 project=original;
 process.env.VERCEL_GIT_COMMIT_SHA='f'.repeat(40);
 assert.equal((await (await current()).json()).directorRecovery.releaseSha,'f'.repeat(40),'Offer uses the deployment that must authorize its request');
 Date.now=()=>Date.parse(cutoff)+1000;stored=null;
 assert.equal((await (await current()).json()).directorRecovery,null);
 assert.ok(lookup>0);
});

test('Chromium recovery authenticates, prevents duplicate clicks, confirms receipts and shows server errors',{timeout:90000},async()=>{
 const source=readFileSync('components/director-recovery-control.tsx','utf8');
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const panel=readFileSync('components/chat-panel.tsx','utf8');
 const start=panel.indexOf('{directorRecovery?.chatId===chatId');
 const end=panel.indexOf('{gameTrial?.chatId===chatId',start);
 assert.ok(start>=0&&end>start,'The actual chat panel must render the recovery control');
 const harness=ts.transpileModule('function RecoveryHarness({directorRecovery,chatId,managedAgentId,actorId}){const setGameTrialRefresh=update=>{window.refreshes=update(window.refreshes)};return <>'+panel.slice(start,end)+'</>}',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const react=['react/umd/react.production.min.js','react-dom/umd/react-dom.production.min.js'].map(f=>readFileSync('node_modules/'+f,'utf8')).join('\n');
 const browser=await chromium.launch({executablePath:process.env.KATIE_TEST_CHROMIUM||await bundled.executablePath(),args:bundled.args,headless:true});
 try{
  const context=await browser.newContext();
  for(const scenario of ['success','403','409','no-owner','malformed','consumed','expired','other-chat','managed-agent']){
   const page=await context.newPage();let posts=0,releaseResponse;
   page.on('pageerror',error=>console.error(scenario,error.message));
   const responseGate=new Promise(resolve=>{releaseResponse=resolve;});
   const data={...offer,receipt:scenario==='consumed'?{...receipt,existing:true}:null};
   const code='const exports={};const require=n=>n==="react"?React:n==="react/jsx-runtime"?{Fragment:React.Fragment,jsx:(t,p,k)=>React.createElement(t,{...p,key:k}),jsxs:(t,p,k)=>React.createElement(t,{...p,key:k})}:{ownerSessionBearer:async()=>'+(scenario==='no-owner'?'null':'"synthetic-owner"')+'};'
    +'Date.now=()=>'+(scenario==='expired'?Date.parse(cutoff)+1000:now)+';window.refreshes=0;'+js
    +';const RecoveryHarness=(()=>{'+harness+';return RecoveryHarness;})();'
    +';ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(RecoveryHarness,{directorRecovery:{chatId:"project-chat",offer:'+JSON.stringify(data)+'},chatId:'+(scenario==='other-chat'?'"another-chat"':'"project-chat"')+',actorId:"owner-actor",managedAgentId:'+(scenario==='managed-agent'?'"worker"':'null')+'}));';
   await page.route('http://localhost/**',async route=>{
    const req=route.request();
    if(new URL(req.url()).pathname==='/control')return route.fulfill({contentType:'text/html; charset=utf-8',body:'<html><head><meta charset="utf-8"></head><div id="root"></div><script>'+react+'</script><script>'+code+'</script></html>'});
    assert.equal(new URL(req.url()).pathname,'/api/projects/organization');
    assert.equal(req.method(),'POST');assert.equal(req.headers().authorization,'Bearer synthetic-owner');
    assert.deepEqual(req.postDataJSON(),{trialAction:'recover_director_once',projectId,releaseSha,cutoff,priorCutoff});posts++;
    await responseGate;
    return route.fulfill({status:scenario==='403'?403:scenario==='409'?409:200,json:scenario==='403'||scenario==='409'?{error:'Exact server rejection '+scenario}:scenario==='malformed'?{}:receipt});
   });
   await page.goto('http://localhost/control');
   if(scenario==='other-chat'||scenario==='managed-agent'){
    assert.equal(await page.getByRole('button').count(),0);
    assert.equal(await page.getByRole('complementary').count(),0);
   }else if(scenario==='consumed'){
    await page.getByRole('status').waitFor();assert.equal(await page.getByRole('button').count(),0);
   }else if(scenario==='expired'){
    await page.getByText('The authorized Director recovery cutoff has expired.').waitFor();
    assert.equal(await page.getByRole('button').count(),0);
   }else{
    const button=page.getByRole('button',{name:'Recover Project Director',exact:true});
    await button.waitFor();
    const posted=scenario==='no-owner'?null:page.waitForRequest(request=>request.method()==='POST');
    await button.evaluate(el=>{el.click();el.click();});
    if(posted)await posted;
    if(scenario==='no-owner'){
     await page.getByRole('alert').filter({hasText:'Sign in as Katie owner'}).waitFor();
    }else{
     await page.getByRole('button',{name:'Submitting Director recovery…',exact:true}).waitFor({timeout:5000}).catch(async error=>{throw Error(scenario+': '+await page.locator('body').innerText(),{cause:error});});
     assert.equal(await page.getByRole('button').isDisabled(),true);
     assert.equal(await page.getByRole('status').count(),0,'No success before server confirmation');
     assert.equal(posts,1);
     releaseResponse();
     if(scenario==='success'){
      await page.getByRole('status').filter({hasText:receipt.assignmentId}).waitFor();
      assert.equal(await page.getByRole('button').count(),0);
      assert.equal(await page.evaluate(()=>window.refreshes),1);
     }else{
      await page.getByRole('alert').waitFor();
      const error=await page.getByRole('alert').innerText();
      assert.equal(error,scenario==='malformed'?'Recovery admission receipt was not confirmed. Refresh the project before continuing.':'Exact server rejection '+scenario);
      assert.equal(await page.getByRole('status').count(),0);
      assert.equal(await page.evaluate(()=>window.refreshes),0);
     }
    }
   }
   assert.equal(posts,['no-owner','consumed','expired','other-chat','managed-agent'].includes(scenario)?0:1);
   await page.close();
  }
 }finally{await browser.close();}
});
