import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {chromium} from 'playwright-core';
import bundledChromium from '@sparticuz/chromium';

for(const successor of [false,true])test('approval feedback survives polling, blocks duplicate clicks, and preserves success when refresh fails; successor='+successor,{timeout:90000},async()=>{
 const browser=await chromium.launch({executablePath:process.env.KATIE_TEST_CHROMIUM||await bundledChromium.executablePath(),args:bundledChromium.args,headless:true});
 try{
  const page=await browser.newPage();let posts=0,reads=0,releasePost,releaseOldPoll,holdPoll=false,reject=true,refreshFails=false;
  const continuation={id:null,projectId:'8199f2d6-bdc3-4ab0-ae5e-53fa417cc3c1',trialId:'trial',accountId:'account',approved:false,live:false,deadline:null,planHash:'c'.repeat(64),sourceSnapshotHash:'d'.repeat(64),spentTokens:195941,plan:{resourceAmendment:true,additionalTokenCap:354059,developmentTokens:373279,assessmentTokens:60000,callsUsed:9,maxCalls:24,callsRemaining:15,developmentRemainingTokens:294059}};
  if(successor){continuation.deadline=new Date(Date.now()+3600000).toISOString();Object.assign(continuation.plan,{ownerSuccessor:true,priorRun:129,developmentRemainingTokens:247327,callsRemaining:11,nativeCallsRemaining:7,remainingDollarMicrousd:4425732});}
  const code=ts.transpileModule(readFileSync('components/benchmark-owner-approval.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const scripts=['react/umd/react.production.min.js','react-dom/umd/react-dom.production.min.js'].map(p=>readFileSync('node_modules/'+p,'utf8'));
  const html=`<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script>${scripts.join('\n')}</script><script>const exports={};const require=name=>name==='react'?React:name==='react/jsx-runtime'?{jsx:(t,p,k)=>React.createElement(t,{...p,key:k}),jsxs:(t,p,k)=>React.createElement(t,{...p,key:k})}:name.includes('browser-owner-session')?{ownerSessionBearer:async()=> 'synthetic-owner-session'}:{SelfToolsOwnerSession:()=>null};${code};ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(exports.BenchmarkOwnerApproval));</script></body></html>`;
  await page.route('http://localhost/**',async route=>{
   const request=route.request(),path=new URL(request.url()).pathname;
   const reply=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
   if(!path.startsWith('/api/'))return route.fulfill({contentType:'text/html',body:html});
   if(request.method()==='POST'){
    posts++;assert.equal(path,'/api/benchmark/715/continuation');
    assert.equal(request.postDataJSON().authorization,successor?'full-amendment-one-successor-fixed-deadline':'full-development-resource-amendment-550000tokens-10usd-4hours');
    await new Promise(resolve=>{releasePost=resolve;});
    if(reject)return reply({error:'The displayed plan changed.',code:'plan_changed'},409);
    refreshFails=true;
    return reply({continuation:{...continuation,id:'saved',approved:true,live:true,deadline:new Date(Date.now()+14400000).toISOString()}});
   }
   reads++;
   if(refreshFails)return reply({error:'Synthetic status outage.'},503);
   if(path.endsWith('/dashboard'))return reply({qualification:{deadline:'2020-01-01',revoked_at:null}});
   if(holdPoll){holdPoll=false;await new Promise(resolve=>{releaseOldPoll=resolve;});}
   return reply({continuation});
  });
  await page.goto('http://localhost/approval');
  const button=page.getByRole('button',{name:successor?'Approve one Take Eleven successor within remaining limits and the existing deadline':'Approve 550,000 cumulative Full tokens, $10 total, and four hours',exact:true});
  await button.click();
  const saving=page.getByRole('button',{name:'Saving approval…',exact:true});await saving.waitFor();assert.equal(await saving.isDisabled(),true);
  // Dispatch another click while the first POST is pending: no second request.
  await saving.dispatchEvent('click');
  for(let i=0;i<100&&posts<1;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(posts,1);
  releasePost();const alert=page.getByRole('alert');await alert.waitFor();assert.match(await alert.innerText(),/HTTP 409; plan_changed/);
  const before=reads;await page.waitForTimeout(16000);assert.ok(reads>before,'15-second poll ran');assert.match(await alert.innerText(),/displayed plan changed/);
  await page.getByRole('button',{name:'Refresh status',exact:true}).click();assert.match(await alert.innerText(),/displayed plan changed/);
  holdPoll=true;await page.getByRole('button',{name:'Refresh status',exact:true}).click();
  await page.waitForFunction(()=>true);
  for(let i=0;i<50&&!releaseOldPoll;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(typeof releaseOldPoll,'function');
  reject=false;await button.click();await saving.waitFor();assert.equal(await alert.count(),0,'explicit retry clears prior submission error');
  for(let i=0;i<100&&posts<2;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(posts,2);releasePost();
  await page.getByText('Approval saved. The existing project can continue within the approved limits.',{exact:true}).waitFor();
  await page.getByText('Status refresh: Synthetic status outage.',{exact:true}).waitFor();
  releaseOldPoll();await page.waitForTimeout(100);
  assert.equal(await button.count(),0,'stale pre-submit poll must not restore approval button');assert.equal(await alert.count(),0);assert.equal(posts,2);
  await page.waitForTimeout(16000);assert.equal(await page.getByText('Approval saved. The existing project can continue within the approved limits.',{exact:true}).count(),1);assert.equal(posts,2);
 }finally{await browser.close();}
});
