import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {chromium} from 'playwright-core';
import bundled from '@sparticuz/chromium';
import {modules} from './helpers/load-project-modules.mjs';

const projectId='fe9d2658-41e3-44c1-ae8e-a0cba98371fe';
const sourceMissionId='911d15bd-be5f-416e-bbac-fbe86ca6fa90';
const windowId='7d216bbe-596e-457e-b84d-e07ad1e80365';
const scopeHash='4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6';
const cutoff='2026-11-18T14:00:00Z', releaseSha='a'.repeat(40),stateHash='b'.repeat(64);
const offered={projectId,sourceMissionId,windowId,scopeHash,releaseSha,cutoff,
 historicalMissions:78,maxMissions:96,tokenAllowance:600000,nodeCount:13,stateHash,
 stage:'retest',status:'blocked'};
const admitted={...offered,stage:'admitted',status:'running',existing:false,authorizedAt:'2026-11-17T16:10:00Z'};
const input={trialAction:'retest_blocked_management',projectId,releaseSha,sourceMissionId,windowId,cutoff,stateHash};

test('original blocked management recovery is authenticated, state-bound and one-shot',async t=>{
 const env={VERCEL_ENV:process.env.VERCEL_ENV,VERCEL_GIT_COMMIT_SHA:process.env.VERCEL_GIT_COMMIT_SHA,
  KATIE_OWNER_AUTH_USER_ID:process.env.KATIE_OWNER_AUTH_USER_ID},oldNow=Date.now;
 Object.assign(process.env,{VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:releaseSha,
  KATIE_OWNER_AUTH_USER_ID:'04ed6c05-a586-4a56-ba81-1b50e378746b'});
 Date.now=()=>Date.parse('2026-11-17T16:00:00Z');
 t.after(()=>{Date.now=oldNow;for(const [k,v] of Object.entries(env)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
 let owner=true,stage='retest';const calls=[];
 const {GET,POST}=modules({
  '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>owner},
  '@/lib/missions/store':{rpc:async(name,args)=>{
   calls.push({name,args});
   if(name==='project_org_blocked_management_retest_offer')return {...offered,stage,
    ...(stage==='admitted'?{authorizedAt:admitted.authorizedAt,admittedReleaseSha:releaseSha}:{})};
   if(name==='project_org_resume_blocked_management_once')return admitted;
   throw Error('Unexpected recovery '+name);
  }},
  '@/lib/data/persistence-store':{getMessages:async()=>[]}
 })('@/app/api/projects/organization/route');
 const request=(body)=>new Request('https://synthetic.test/api/projects/organization',{
  method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 owner=false;assert.equal((await POST(request(input))).status,403);
 assert.equal((await GET(new Request('https://synthetic.test/api/projects/organization?projectId='+projectId))).status,403);
 assert.equal(calls.length,0);
 owner=true;
 assert.equal((await POST(request({...input,ownerId:'forged'}))).status,400);
 assert.equal((await POST(request({...input,sourceMissionId:'11111111-1111-4111-8111-111111111111'}))).status,400);
 assert.equal((await POST(request({...input,windowId:'11111111-1111-4111-8111-111111111111'}))).status,400);
 assert.equal((await POST(request({...input,cutoff:'2026-11-19T14:00:00Z'}))).status,400);
 assert.equal((await POST(request({...input,stateHash:'c'.repeat(64)}))).status,409);
 assert.equal((await POST(request({...input,releaseSha:'d'.repeat(40)}))).status,409);
 process.env.VERCEL_ENV='preview';assert.equal((await POST(request(input))).status,409);
 process.env.VERCEL_ENV='production';
 assert.equal((await (await GET(new Request('https://synthetic.test/api/projects/organization?projectId='+projectId))).json()).managementRetest.stage,'retest');
 const result=await POST(request(input));
 assert.equal(result.status,200);assert.deepEqual(JSON.parse(JSON.stringify(await result.json())),admitted);
 const writes=calls.filter(c=>c.name==='project_org_resume_blocked_management_once');
 assert.equal(writes.length,1);
 assert.deepEqual(JSON.parse(JSON.stringify(writes[0].args)),{
  p_owner:process.env.KATIE_OWNER_AUTH_USER_ID,p_project:projectId,p_release:releaseSha,
  p_source_mission:sourceMissionId,p_window:windowId,p_cutoff:cutoff,p_state_hash:stateHash});
 stage='admitted';
 assert.equal((await POST(request(input))).status,409,'Consumed receipt cannot restart a second mission');
 assert.equal(calls.filter(c=>c.name==='project_org_resume_blocked_management_once').length,1);
 const recorded=(await (await GET(new Request('https://synthetic.test/api/projects/organization?projectId='+projectId))).json()).managementRetest;
 assert.equal(recorded.stage,'admitted');assert.equal(recorded.authorizedAt,admitted.authorizedAt);
 Date.now=()=>Date.parse('2026-11-18T13:57:00Z');
 stage='retest';assert.equal((await POST(request(input))).status,409,'Expired or near-expiry window refuses mutation');
});

test('real Chromium one-time retest control requires owner click and shows a recorded receipt',{timeout:90000},async()=>{
 const code=ts.transpileModule(readFileSync('components/director-recovery-control.tsx','utf8'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const react=['react/umd/react.production.min.js','react-dom/umd/react-dom.production.min.js']
  .map(file=>readFileSync('node_modules/'+file,'utf8')).join('\n');
 const browser=await chromium.launch({executablePath:process.env.KATIE_TEST_CHROMIUM||await bundled.executablePath(),args:bundled.args,headless:true});
 // Sparticuz headless Chromium can hang when opening a second page in this CI fixture.
 // Reuse one page; each scenario navigates to a fresh document and resets its route.
 const page=await browser.newPage();
 try{
  for(const scenario of ['success','no-owner','409','admitted']){
   console.log('RETEST_CHROMIUM_SCENARIO_START: '+scenario);
   console.log('RETEST_CHROMIUM_STEP: '+scenario+' reusePage:begin');
   await page.unroute('http://localhost/**');
   page.removeAllListeners('pageerror');
   console.log('RETEST_CHROMIUM_STEP: '+scenario+' reusePage:done');
   let posts=0,releaseResponse,requestObserved;
   const errors=[];page.on('pageerror',e=>errors.push(e.message));
   const requestSeen=new Promise(resolve=>{requestObserved=resolve;});
   // Fail-closed watchdog: a failing browser assertion must never leave a held
   // intercepted POST keeping Chromium and the test process alive indefinitely.
   const gate=new Promise(resolve=>{
    let released=false;
    releaseResponse=()=>{if(!released){released=true;resolve();}};
    setTimeout(releaseResponse,15000).unref();
   });
   const body={projectId,releaseSha,cutoff,priorCutoff:cutoff,receipt:null,
    managementRetest:scenario==='admitted'?{...admitted,admittedReleaseSha:releaseSha}:offered};
   const script='const exports={};const require=n=>n==="react"?React:n==="react/jsx-runtime"?{Fragment:React.Fragment,jsx:(t,p,k)=>React.createElement(t,{...p,key:k}),jsxs:(t,p,k)=>React.createElement(t,{...p,key:k})}:{ownerSessionBearer:async()=>'+
    (scenario==='no-owner'?'null':'"synthetic-owner"')+'};'+
    'Date.now=()=>'+Date.parse('2026-11-17T16:00:00Z')+';window.refreshes=0;'+code+
    ';ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(exports.DirectorRecoveryControl,{recovery:'+JSON.stringify(body)+',onRefresh:()=>window.refreshes++}));';
   await page.route('http://localhost/**',async route=>{
    if(new URL(route.request().url()).pathname==='/control')
     return route.fulfill({contentType:'text/html; charset=utf-8',body:'<html><div id="root"></div><script>'+react+'</script><script>'+script+'</script></html>'});
    posts++;
    // A failed assertion inside the route callback aborts fetch before React
    // can expose its pending state. Keep the request held; assert outside.
    const sent={method:route.request().method(),headers:route.request().headers(),data:route.request().postDataJSON()};
    requestObserved(sent);
    await gate;
    return route.fulfill({status:scenario==='409'?409:200,json:scenario==='409'?{error:'Stale state'}:admitted});
   });
   console.log('RETEST_CHROMIUM_STEP: '+scenario+' goto:begin');
   await page.goto('http://localhost/control',{waitUntil:'domcontentloaded',timeout:12000});
   console.log('RETEST_CHROMIUM_STEP: '+scenario+' goto:done');
   if(scenario==='admitted'){
    await page.getByText('One-time retest has been recorded.').waitFor();
    assert.equal(await page.getByRole('button',{name:'Authorize one management retest'}).count(),0);
   }else{
    const button=page.getByRole('button',{name:'Authorize one management retest'});
    console.log('RETEST_CHROMIUM_STEP: '+scenario+' button:begin');
    await button.waitFor({timeout:12000});
    console.log('RETEST_CHROMIUM_STEP: '+scenario+' button:done');
    // Successful/stale-owner cases verify a double-click cannot duplicate an
    // authenticated POST. An unauthenticated request needs one click only.
    console.log('RETEST_CHROMIUM_STEP: '+scenario+' click:begin');
    await button.evaluate((el,doubleClick)=>{el.click();if(doubleClick)el.click();},scenario!=='no-owner');
    console.log('RETEST_CHROMIUM_STEP: '+scenario+' click:done');
    if(scenario==='no-owner'){
     try{
      console.log('RETEST_CHROMIUM_STEP: no-owner alert:begin');
      await page.getByRole('alert').filter({hasText:'Sign in as Katie owner'}).waitFor({timeout:8000});
      console.log('RETEST_CHROMIUM_STEP: no-owner alert:done');
      console.log('RETEST_CHROMIUM_NO_OWNER_DENIAL_PASS: no authenticated POST');
     }catch(error){
      throw Error('No-owner denial was not rendered: '+error.message+
       '; buttons='+JSON.stringify(await page.getByRole('button').allTextContents())+
       '; alerts='+JSON.stringify(await page.getByRole('alert').allTextContents())+
       '; browserErrors='+JSON.stringify(errors));
     }
    }else{
     let sent;
     try{
      sent=await Promise.race([requestSeen,new Promise((_,reject)=>setTimeout(()=>reject(Error('Owner POST not observed')),12000))]);
      await page.getByRole('button',{name:'Authorizing one retest…'}).waitFor({timeout:12000});
     }catch(error){
      releaseResponse();
      throw Error('Owner pending-state verification failed: '+error.message+
       '; buttons='+JSON.stringify(await page.getByRole('button').allTextContents())+
       '; alerts='+JSON.stringify(await page.getByRole('alert').allTextContents())+
       '; browserErrors='+JSON.stringify(errors));
     }
     assert.equal(sent.method,'POST');
     assert.equal(sent.headers.authorization,'Bearer synthetic-owner');
     assert.deepEqual(sent.data,input);
     assert.equal(posts,1,'Double-click cannot authorize more than one retry');
     releaseResponse();
     if(scenario==='409')await page.getByRole('alert').filter({hasText:'Stale state'}).waitFor();
     else{
      await page.getByText('One-time retest has been recorded.').waitFor();
      assert.equal(await page.evaluate(()=>window.refreshes),1);
      assert.equal(await button.count(),0);
     }
    }
   }
   assert.equal(posts,scenario==='success'||scenario==='409'?1:0);
   console.log('RETEST_CHROMIUM_SCENARIO_PASS: '+scenario);
  }
 }finally{await page.close({runBeforeUnload:false});await browser.close();}
});
