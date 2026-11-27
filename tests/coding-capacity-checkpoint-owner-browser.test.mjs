import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {chromium} from 'playwright-core';
import bundled from '@sparticuz/chromium';
import {modules} from './helpers/load-project-modules.mjs';

const projectId='fe9d2658-41e3-44c1-ae8e-a0cba98371fe',packageId='f88d4d10-dfe4-479e-a2cf-41b3e8209e47';
const chatId='970e28c6-6caf-4340-894c-4b66c8aa0d21',actorId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ownerId='04ed6c05-a586-4a56-ba81-1b50e378746b',releaseSha='1161'.repeat(10),deploymentId='dpl_RetainedCheckpointOwnerControl',generation=71;
const cutoff='2026-11-28T16:00:00.000Z',clock=Date.parse('2026-11-27T16:10:00Z'),stateHash='a'.repeat(64);
const transpile=s=>ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;

test('Retained checkpoint conversation GET and exact owner consent in Chromium',{timeout:90000},async t=>{
 const env={VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:releaseSha,VERCEL_DEPLOYMENT_ID:deploymentId,KATIE_OWNER_AUTH_USER_ID:ownerId};
 const old=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]])),oldNow=Date.now;
 Object.assign(process.env,env);Date.now=()=>clock;
 t.after(()=>{Date.now=oldNow;for(const k in old){if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}});
 let offers=0,writes=0,denyOffer=false,projectStatus='blocked',lastPayload;
 let offer;
 const mock=modules({
  '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async request=>request.headers.get('authorization')==='Bearer synthetic-owner'&&(request.method==='GET'||request.headers.get('origin')===new URL(request.url).origin)},
  '@/lib/data/persistence-store':{getChatById:async id=>id===chatId?{actorId}:null,getMessages:async()=>[]},
  '@/lib/projects/store':{projectForChat:async(a,c)=>a===actorId&&c===chatId?{id:projectId,status:projectStatus,phase:'development',organization_version:1,max_missions:118,max_cycles:5,deadline:cutoff}:null,
    projectRpc:async name=>{assert.equal(name,'project_provider_mode');return true;}},
  '@/lib/projects/recovery-budget':{recoveryResourceProposal:async()=>null},
  '@/lib/executive/delivery':{hasPendingExecutiveDelivery:async()=>false},
  '@/lib/projects/management-context-preflight':{preflightManagementContext:async(p,n,a,b,l)=>({principalId:n,inputLimit:l,chars:59021,sha256:'c'.repeat(64)})},
  '@/lib/projects/mission79-active-release':{verifyMission79ActiveProductionSha:async()=>true},
  '@/lib/missions/store':{rpc:async(name,args)=>{
   if(['project_org_package_execution_offer','project_org_package_release_offer','project_org_package_corrective_offer','project_org_package_completion_offer'].includes(name))throw Error('Consumed historical offer');
   if(name==='project_org_package_checkpoint_offer'){offers++;if(denyOffer)throw Error('Native offer unavailable');return offer;}
   if(name==='project_org_package_invalid_retry_offer')throw Error('Consumed historical retry');
   if(name==='project_org_retest_release_epoch')return {generation,active:true,deploymentId};
   assert.equal(name,'project_org_package_checkpoint_authorize');writes++;lastPayload=JSON.parse(JSON.stringify(args));
   return {...offer,stage:'authorized',authorizationId:args.p_authorization};
  }}
 });
 const lib=mock('@/lib/projects/package-execution-authorization');
 offer={stage:'authorize',projectId,packageId,priorAuthorizationId:ownerId,releaseSha,releaseGeneration:generation,deploymentId,scopeHash:'4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6',cutoff,stateHash,contractFingerprint:'b'.repeat(64),managerId:ownerId,coderId:actorId,writerId:actorId,reviewerId:projectId,paths:[],developmentPaths:['app/milestone-3-tic-tac-toe/page.tsx'],terms:lib.PACKAGE_TERMS,checkpointRecovery:{priorCutoff:'2026-11-26T19:45:00.000Z',missionId:'aeffa160-d240-46d1-b240-dc0ac7f488d5',assignmentId:'1c940466-c034-4e21-8dc5-d2ecf1212098',priorRunId:'45863524946',candidateSha:'7b0a415189ffd849bbaa645ce1bea499693bee94',checkpointSha:'a3a853e00278d719a14f843c4abdbae04b7ab141',sourceTreeSha:'ae1fb9b658acb4bf3445464d3a37e62aeb457123',usedMissions:116,usedAttempts:4,paidInferences:22,nativeInferences:12,terms:lib.CHECKPOINT_TERMS}};
 const projectRoute=mock('@/app/api/projects/route'),orgRoute=mock('@/app/api/projects/organization/route');
 const get=async(bearer,chat=chatId)=>{
  const request=new Request('http://localhost/api/projects?actorId='+actorId+'&chatId='+chat,{headers:bearer?{Authorization:'Bearer '+bearer}:{}});
  request.nextUrl=new URL(request.url);return projectRoute.GET(request);
 };
 assert.equal((await (await get(null)).json()).directorRecovery,null);
 assert.equal((await (await get('different-owner')).json()).directorRecovery,null);
 assert.equal(offers,0,'No offer lookup without verified owner');
 assert.equal((await get('synthetic-owner','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).status,404);
 const before=await (await get('synthetic-owner')).json();
 assert.equal(before.directorRecovery.packageExecutionRecovery.releaseGeneration,generation);
 assert.deepEqual(before.directorRecovery.packageExecutionRecovery.checkpointRecovery,JSON.parse(JSON.stringify(offer.checkpointRecovery)));
 denyOffer=true;
 const unavailable=await (await get('synthetic-owner')).json();
 assert.match(unavailable.directorRecovery.managementActivationError,/No owner approval was recorded/);
 denyOffer=false;
 assert.equal(writes,0);
 const valid={trialAction:'authorize_package_checkpoint_recovery',projectId,packageId,authorizationId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',releaseSha,releaseGeneration:generation,deploymentId,stateHash,terms:lib.PACKAGE_TERMS,checkpointTerms:lib.CHECKPOINT_TERMS,cutoff,candidateSha:offer.checkpointRecovery.candidateSha,checkpointSha:offer.checkpointRecovery.checkpointSha,priorRunId:offer.checkpointRecovery.priorRunId,paidInferenceConsent:true};
 const submit=(payload,authenticated=true)=>orgRoute.POST(new Request('http://localhost/api/projects/organization',{method:'POST',headers:{Origin:'http://localhost',...(authenticated?{Authorization:'Bearer synthetic-owner'}:{}),'Content-Type':'application/json'},body:JSON.stringify(payload)}));
 assert.equal((await submit(valid,false)).status,403);
 for(const mutation of [{candidateSha:'0'.repeat(40)},{checkpointSha:'1'.repeat(40)},{priorRunId:'999'},{cutoff:'2026-11-28T17:00:00.000Z'},{releaseGeneration:generation-1},{stateHash:'0'.repeat(64)},{checkpointTerms:{...lib.CHECKPOINT_TERMS,nativeAutomaticRepairs:1}},{paidInferenceConsent:false}]){
  assert.ok((await submit({...valid,...mutation})).status>=400);
 }
 assert.equal(writes,0,'No altered or unauthenticated request may write a receipt');
 const panel=readFileSync('components/chat-panel.tsx','utf8');
 const start=panel.indexOf('{directorRecovery?.chatId===chatId');
 const end=panel.indexOf('{gameTrial?.chatId===chatId',start);
 assert.ok(start>=0&&end>start);
 assert.match(panel,/setDirectorRecovery\(p\.directorRecovery\?\{chatId,offer:p\.directorRecovery\}:null\)/);
 const harness=transpile('function RecoveryHarness({directorRecovery,chatId,managedAgentId,actorId}){const setGameTrialRefresh=update=>{window.refreshes=update(window.refreshes)};return <div data-testid="recovery-harness">'+panel.slice(start,end)+'</div>}');
 const director=transpile(readFileSync('components/director-recovery-control.tsx','utf8'));
 const control=transpile(readFileSync('components/package-execution-control.tsx','utf8'));
 const react=['react/umd/react.production.min.js','react-dom/umd/react-dom.production.min.js'].map(f=>readFileSync('node_modules/'+f,'utf8')).join('\n');
 const browser=await chromium.launch({executablePath:process.env.KATIE_TEST_CHROMIUM||await bundled.executablePath(),args:bundled.args,headless:true});
 try{
  const context=await browser.newContext({timezoneId:'UTC'});
  for(const scenario of ['no-owner','owner','wrong-chat','managed-agent']){
   const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
   const bearer=scenario==='no-owner'?null:'synthetic-owner';
   const htmlCode='const jsxRuntime={Fragment:React.Fragment,jsx:(t,p,k)=>React.createElement(t,{...p,key:k}),jsxs:(t,p,k)=>React.createElement(t,{...p,key:k})};const load=(code,extra={})=>{const exports={};const require=n=>n==="react"?React:n==="react/jsx-runtime"?jsxRuntime:n==="@/lib/tools/browser-owner-session"?{ownerSessionBearer:async()=>'+JSON.stringify(bearer)+'}:extra[n]||{};new Function("exports","require",code)(exports,require);return exports;};'
    +'Date.now=()=>'+clock+';window.refreshes=0;const pkg=load('+JSON.stringify(control)+');const {DirectorRecoveryControl}=load('+JSON.stringify(director)+',{"./package-execution-control":pkg});'
    +'const RecoveryHarness=(()=>{const exports={};const require=n=>n==="react/jsx-runtime"?jsxRuntime:React;'+harness+';return RecoveryHarness;})();'
    +'const render=async()=>{const r=await fetch("/api/projects?actorId='+actorId+'&chatId='+chatId+'",{headers:'+JSON.stringify(bearer?{Authorization:'Bearer '+bearer}:{})+'});const p=await r.json();ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(RecoveryHarness,{directorRecovery:p.directorRecovery?{chatId:'+JSON.stringify(chatId)+',offer:p.directorRecovery}:null,chatId:'+JSON.stringify(scenario==='wrong-chat'?'other-chat':chatId)+',actorId:'+JSON.stringify(actorId)+',managedAgentId:'+JSON.stringify(scenario==='managed-agent'?'worker':null)+'}));window.rendered=true;};render();';
   await page.route('http://localhost/**',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.pathname==='/control')return route.fulfill({contentType:'text/html',body:'<html><head><meta charset="utf-8"></head><div id="root"></div><script>'+react+'</script><script>'+htmlCode+'</script></html>'});
    if(url.pathname==='/api/projects'){const res=await get(req.headers().authorization?.replace(/^Bearer /,''));return route.fulfill({status:res.status,json:await res.json()});}
    assert.equal(url.pathname,'/api/projects/organization');assert.equal(req.method(),'POST');
    assert.equal(req.headers().authorization,'Bearer synthetic-owner');
    const payload=req.postDataJSON();
    assert.equal(payload.trialAction,'authorize_package_checkpoint_recovery');assert.equal(payload.releaseGeneration,generation);assert.equal(payload.paidInferenceConsent,true);
    const res=await orgRoute.POST(new Request('http://localhost/api/projects/organization',{method:'POST',headers:{Origin:'http://localhost',Authorization:req.headers().authorization,'Content-Type':'application/json'},body:JSON.stringify(payload)}));
    return route.fulfill({status:res.status,json:await res.json()});
   });
   await page.goto('http://localhost/control');await page.getByTestId('recovery-harness').waitFor({state:'attached'});
   const button=page.getByRole('button',{name:'Authorize checkpoint completion',exact:true});
   if(scenario!=='owner'){assert.equal(await button.count(),0);await page.close();continue;}
   await button.waitFor();assert.equal(await button.isDisabled(),true);
   await page.getByRole('checkbox').check();assert.equal(await button.isEnabled(),true);
   await button.click();
   await page.getByRole('status').filter({hasText:'Signed checkpoint authorization:'}).waitFor();
   assert.equal(writes,1);assert.equal(lastPayload.p_generation,generation);assert.equal(lastPayload.p_state_hash,stateHash);
   assert.deepEqual(lastPayload.p_terms,JSON.parse(JSON.stringify(lib.CHECKPOINT_TERMS)));
   assert.equal(await page.evaluate(()=>window.refreshes),1);assert.deepEqual(errors,[]);
   await page.close();
  }
 }finally{await browser.close();}
 assert.equal(writes,1,'Only the synthetic owner explicitly consented; no real production authorization');
 console.log('RETAINED_CHECKPOINT_OWNER_CONVERSATION_BROWSER_PASS: actual project GET and JSX, synthetic authenticated owner, exact consent POST, signed receipt, other contexts denied');
});
