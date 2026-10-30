import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {chromium} from 'playwright-core';
import bundledChromium from '@sparticuz/chromium';

test('same-task renewal displays remaining allowance and requires explicit exact-plan approval, surviving reload',{timeout:90000},async()=>{
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
   return reply({continuation:{id:approved?'renewal':null,projectId,trialId:'preserved-trial',accountId:'preserved-account',approved,live:approved,deadline:approved?new Date(Date.now()+4*3600000).toISOString():null,planHash,sourceSnapshotHash:'d'.repeat(64),spentTokens:131140,plan:{kind:'development-renewal',additionalTokenCap:165581,specificationTokens:0,developmentTokens:120000,developmentSpentTokens:14419,developmentRemainingTokens:105581,assessmentTokens:60000}}});
  });
  await page.goto('http://localhost/approval');
  const button=page.getByRole('button',{name:'Approve this continuation using remaining Full allowance'});await button.waitFor();
  const text=await page.locator('body').innerText();
  for(const expected of ['Full Katie continuation approval','165,581 additional tokens','105,581 tokens remaining','assessment: 60,000','same approved development task for four hours','No new funds','131,140 tokens already charged','No research or specification restart'])assert.ok(text.includes(expected),expected);
  assert.equal(posts.length,0);
  await page.getByRole('button',{name:'Refresh status',exact:true}).click();assert.equal(posts.length,0);
  await button.click();await page.getByText('Continuation approved until',{exact:false}).waitFor();
  assert.deepEqual(posts,[{approve:true,authorization:'full-continuation-displayed-plan-existing-budget-4hours',projectId,planHash}]);
  await page.reload();await page.getByText('Continuation approved until',{exact:false}).waitFor();
  assert.equal(await button.count(),0);assert.equal(posts.length,1);assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('owner resource amendment displays exact fixed-deadline resources and requires explicit exact-plan approval, surviving reload',{timeout:90000},async()=>{
 const browser=await chromium.launch({executablePath:process.env.KATIE_TEST_CHROMIUM||await bundledChromium.executablePath(),args:bundledChromium.args,headless:true});
 try{
  const page=await browser.newPage(),errors=[],posts=[];page.on('pageerror',e=>errors.push(e.message));
  let approved=false;
  const fixedDeadline=new Date(Date.now()+2*3600000).toISOString(),planHash='c'.repeat(64),projectId='8199f2d6-bdc3-4ab0-ae5e-53fa417cc3c1';
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
   return reply({continuation:{id:approved?'renewal':null,projectId,trialId:'preserved-trial',accountId:'preserved-account',approved,live:approved,deadline:fixedDeadline,planHash,sourceSnapshotHash:'d'.repeat(64),spentTokens:195941,plan:{kind:'development-renewal',resourceAmendment:true,allocationIncreaseTokens:50000,maxCalls:24,callsUsed:9,callsRemaining:15,unallocatedAccountTokens:3279,additionalTokenCap:150780,specificationTokens:0,developmentTokens:170000,developmentSpentTokens:79220,developmentRemainingTokens:90780,assessmentTokens:60000}}});
  });
  await page.goto('http://localhost/approval');
  const button=page.getByRole('button',{name:'Approve this exact resource amendment before the fixed deadline'});await button.waitFor();
  const text=await page.locator('body').innerText();
  for(const expected of ['150,780 additional tokens','90,780 tokens','170,000 tokens','call limit from 12 to 24','9 calls are already charged','15 more calls','Assessment retains 60,000','50,000 previously unused Full tokens','3,279 remain unallocated','there is no time extension','195,941 tokens already charged','One new execution only'])assert.ok(text.includes(expected),expected);
  assert.equal(posts.length,0);
  await page.getByRole('button',{name:'Refresh status',exact:true}).click();assert.equal(posts.length,0);
  await button.click();await page.getByText('Continuation approved until',{exact:false}).waitFor();
  assert.deepEqual(posts,[{approve:true,authorization:'full-development-resource-amendment-fixed-deadline',projectId,planHash}]);
  await page.reload();await page.getByText('Continuation approved until',{exact:false}).waitFor();
  assert.equal(await button.count(),0);assert.equal(posts.length,1);assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
