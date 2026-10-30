import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {chromium} from 'playwright-core';
import bundledChromium from '@sparticuz/chromium';

test('625k capacity renewal displays all limits and requires explicit exact-plan approval, surviving reload',{timeout:90000},async()=>{
 const browser=await chromium.launch({executablePath:process.env.KATIE_TEST_CHROMIUM||await bundledChromium.executablePath(),args:bundledChromium.args,headless:true});
 try{
  const page=await browser.newPage(),errors=[],posts=[];page.on('pageerror',e=>errors.push(e.message));
  let approved=false;
  const planHash='c'.repeat(64),projectId='8199f2d6-bdc3-4ab0-ae5e-53fa417cc3c1';
  const code=ts.transpileModule(readFileSync('components/benchmark-owner-approval.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const scripts=['react/umd/react.production.min.js','react-dom/umd/react-dom.production.min.js'].map(p=>readFileSync('node_modules/'+p,'utf8'));
  const html=`<!doctype html><html><body><div id="root"></div><script>${scripts.join('\n')}</script><script>const exports={};const require=name=>name==='react'?React:name==='react/jsx-runtime'?{jsx:(t,p,k)=>React.createElement(t,{...p,key:k}),jsxs:(t,p,k)=>React.createElement(t,{...p,key:k})}:name.includes('browser-owner-session')?{ownerSessionBearer:async()=> 'synthetic-owner-session'}:{SelfToolsOwnerSession:()=>null};${code};ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(exports.BenchmarkOwnerApproval));</script></body></html>`;
  await page.route('http://localhost/**',async route=>{
   const req=route.request(),path=new URL(req.url()).pathname;
   const reply=body=>route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
   if(!path.startsWith('/api/'))return route.fulfill({contentType:'text/html',body:html});
   assert.equal(req.headers().authorization,'Bearer synthetic-owner-session');
   if(req.method()==='POST'){
    assert.equal(path,'/api/benchmark/715/continuation');posts.push(req.postDataJSON());approved=true;
   }
   if(path.endsWith('/dashboard'))return reply({canRetry:false,qualification:{deadline:'2020-01-01',revoked_at:null},consent:null,execution:null});
   if(path.endsWith('/development'))return reply({task:null});
   assert.equal(path,'/api/benchmark/715/continuation');
   return reply({continuation:{id:approved?'renewal':null,projectId,trialId:'preserved-trial',accountId:'preserved-account',approved,live:approved,deadline:approved?new Date(Date.now()+4*3600000).toISOString():null,planHash,sourceSnapshotHash:'d'.repeat(64),spentTokens:287895,plan:{kind:'development-renewal',resourceAmendment:true,capacityRenewal:true,cumulativeTokenCap:625000,maxCalls:32,callsUsed:17,callsRemaining:15,nativeCallsRemaining:11,historicalExposureMicrousd:5657365,remainingDollarMicrousd:4342635,estimatedAdditionalCostMicrousd:3500000,additionalTokenCap:337105,specificationTokens:0,developmentTokens:448279,developmentSpentTokens:171174,developmentRemainingTokens:277105,assessmentTokens:60000}}});
  });
  await page.goto('http://localhost/approval');
  const button=page.getByRole('button',{name:'Approve one Take Eleven execution: 625,000 cumulative tokens, 32 calls, $10 total, four hours'});await button.waitFor();
  const text=await page.locator('body').innerText();
  for(const expected of ['337,105 additional tokens','625,000 cumulative tokens','277,105 tokens remaining','Assessment separately retains 60,000','four hours starting at authenticated approval','287,895 tokens already charged','$5.657365','$4.342635','$3.50','eleven are available','No automatic retries'])assert.ok(text.includes(expected),expected);
  assert.equal(posts.length,0);
  await page.getByRole('button',{name:'Refresh status',exact:true}).click();assert.equal(posts.length,0);
  await button.click();await page.getByText('Continuation approved until',{exact:false}).waitFor();
  assert.deepEqual(posts,[{approve:true,authorization:'full-capacity-renewal-625000tokens-32calls-10usd-4hours',projectId,planHash}]);
  await page.reload();await page.getByText('Continuation approved until',{exact:false}).waitFor();
  assert.equal(await button.count(),0);assert.equal(posts.length,1);assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
