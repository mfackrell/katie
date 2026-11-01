import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {chromium} from 'playwright-core';
import bundledChromium from '@sparticuz/chromium';

test('owner sees one exact proposal; only committed decisions change status',{timeout:90000},async()=>{
 const browser=await chromium.launch({executablePath:process.env.KATIE_TEST_CHROMIUM||await bundledChromium.executablePath(),args:bundledChromium.args,headless:true});
 try{
  const page=await browser.newPage(),posts=[],errors=[];page.on('pageerror',e=>errors.push(e.message));let state='pending',fail=false,release;
  const position={cumulativeTokens:625000,developmentTokens:448279,developmentCalls:32,completionCalls:4,completionTokens:60000,assessmentTokens:60000,assessmentCalls:null,accountEncumberedTokens:474895,developmentConsumedCalls:28,committedMicrousd:'5657365',outstandingMicrousd:'123450',ceilingMicrousd:'10000000',expiresAt:Date.now()+3600000};
  const proposal={id:'c'.repeat(64),binding:{taskId:'11111111-1111-4111-8111-111111111111',projectId:'22222222-2222-4222-8222-222222222222',scopeHash:'f'.repeat(64)},checkpointSha:'a'.repeat(40),scope:'unchanged scope',acceptance:'frozen requirements',currentPhase:'repair',completed:['implementation','initial_review'],remaining:['repair','verification','final_review','do_completion','assessment'],shortages:['nativeCalls'],uncertainties:['token_estimate_unknown'],evidence:[],current:position,proposed:{...position,developmentCalls:34},additions:{tokens:0,nativeCalls:2},estimatedIncrementalMicrousd:null,conservativeIncrementalMicrousd:null,expiresAt:Date.now()+3600000};
  const code=ts.transpileModule(readFileSync('components/lifecycle-owner-approval.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const scripts=['react/umd/react.production.min.js','react-dom/umd/react-dom.production.min.js'].map(p=>readFileSync('node_modules/'+p,'utf8'));
  const html=`<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script>${scripts.join('\n')}</script><script>const exports={};const require=name=>name==='react'?React:name==='react/jsx-runtime'?{Fragment:React.Fragment,jsx:(t,p,k)=>React.createElement(t,{...p,key:k}),jsxs:(t,p,k)=>React.createElement(t,{...p,key:k})}:{ownerSessionBearer:async()=> 'synthetic-owner-session'};${code};ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(exports.LifecycleOwnerApproval));</script></body></html>`;
  await page.route('http://localhost/**',async route=>{
   const req=route.request();if(!new URL(req.url()).pathname.startsWith('/api/'))return route.fulfill({contentType:'text/html',body:html});
   assert.equal(req.headers().authorization,'Bearer synthetic-owner-session');
   if(req.method()==='POST'){
    posts.push(req.postDataJSON());await new Promise(r=>{release=r});
    if(fail)return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({state:'stale',error:'Task changed. Refresh before deciding again.'})});
    state=posts.at(-1).decision;
   }
   return route.fulfill({contentType:'application/json',body:JSON.stringify({state,proposal})});
  });
  await page.goto('http://localhost/approval');
  const approve=page.getByRole('button',{name:'Approve exactly this amendment'});try{await approve.waitFor({timeout:5000});}catch(e){assert.fail(JSON.stringify({errors,body:await page.locator('body').innerText()}));}
  const text=await page.locator('body').innerText();for(const expected of ['2 additional native calls','0 additional cumulative tokens','$5.66','$0.12','$10.00','Unknown','Protected completion','Protected assessment','initial_review'])assert.ok(text.includes(expected),expected);
  assert.equal(posts.length,0);await approve.click();try{await page.getByRole('button',{name:'Recording decision…'}).waitFor({timeout:5000});}catch{assert.fail(JSON.stringify({errors,posts,body:await page.locator('body').innerText()}));}
  assert.equal(await page.getByText('Amendment authorized; continuation queued',{exact:true}).count(),0);
  assert.deepEqual(posts,[{taskId:proposal.binding.taskId,proposalId:proposal.id,decision:'approved'}]);while(!release)await new Promise(r=>setTimeout(r,5));release();release=undefined;
  await page.getByText('Amendment authorized; continuation queued',{exact:true}).waitFor();await page.reload();await page.getByText('Amendment authorized; continuation queued',{exact:true}).waitFor();assert.equal(posts.length,1);
  state='pending';fail=true;await page.reload();await approve.click();try{await page.getByRole('button',{name:'Recording decision…'}).waitFor({timeout:5000});}catch{assert.fail(JSON.stringify({errors,posts,body:await page.locator('body').innerText()}));}while(!release)await new Promise(r=>setTimeout(r,5));release();release=undefined;await page.getByRole('alert').waitFor();assert.equal(await page.getByText('Amendment authorized; continuation queued',{exact:true}).count(),0);
  fail=false;await page.getByRole('button',{name:'Reject amendment',exact:true}).click();try{await page.getByRole('button',{name:'Recording decision…'}).waitFor({timeout:5000});}catch{assert.fail(JSON.stringify({errors,posts,body:await page.locator('body').innerText()}));}while(!release)await new Promise(r=>setTimeout(r,5));release();release=undefined;await page.getByText('Owner rejected; saved work remains recoverable',{exact:true}).waitFor();assert.equal(posts.at(-1).decision,'rejected');
  for(const value of ['expired','stale','resumed','continuation_failed']){state=value;await page.reload();await page.getByRole('region',{name:'Development resource approval'}).waitFor();assert.equal(await approve.count(),0);}
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
