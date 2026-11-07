import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {chromium} from 'playwright-core';
import bundledChromium from '@sparticuz/chromium';

const originalChat='e53defeb-16eb-457e-aa07-435141165ee8';
const otherChat='11111111-1111-4111-8111-111111111111';
const sha='a'.repeat(64);
const expectedLimits={
 cumulativeTokens:289620,developmentTokens:229620,assessmentTokens:60000,
 completionTokens:60000,developmentCalls:16,assessmentCalls:4,
 completionCalls:4,perCallMicrousd:1680000,ceilingMicrousd:9000000,
 durationSeconds:14400
};

test('actual Task 4A postpaid UI replaces generic lifecycle in original chat and retains unrelated generic approvals',{timeout:90000},async()=>{
 const panel=readFileSync('components/chat-panel.tsx','utf8');
 const start=panel.indexOf('aria-label="Project approvals and recovery"');
 const end=panel.indexOf('</section>',start);
 assert.ok(start>=0&&end>start);
 const lines=panel.slice(start,end).split('\n');
 const generic=lines.filter(x=>x.includes('<LifecycleOwnerApproval '));
 const postpaid=lines.filter(x=>x.includes('<Task4aPostpaidContinuationApproval '));
 assert.equal(generic.length,1);
 assert.equal(postpaid.length,1);
 assert.match(generic[0],/chatId!==/);
 const transpile=source=>ts.transpileModule(source,{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}
 }).outputText;
 const realPostpaid=transpile(readFileSync('components/task4a-postpaid-continuation-approval.tsx','utf8'));
 const harness=transpile(
  'function ApprovalHarness({chatId,managedAgentId}) { return (<section aria-label="Project approvals and recovery">'
  +generic[0]+'\n'+postpaid[0]+'</section>); }'
 );
 const reactScripts=['react/umd/react.production.min.js','react-dom/umd/react-dom.production.min.js']
  .map(x=>readFileSync('node_modules/'+x,'utf8')).join('\n');
 const code='const exports={};\n'
  +'const require=name=>name==="react"?React:name==="react/jsx-runtime"?{Fragment:React.Fragment,jsx:(t,p,k)=>React.createElement(t,{...p,key:k}),jsxs:(t,p,k)=>React.createElement(t,{...p,key:k})}:{ownerSessionBearer:async()=>"synthetic-owner"};\n'
  +realPostpaid+'\n'
  +'const LifecycleOwnerApproval=()=>React.createElement("p",{"data-testid":"generic-owner-approval"},"Generic resource approval");\n'
  +'const ApprovalHarness=(function(){'+harness+';return ApprovalHarness;})();\n'
  +'ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(ApprovalHarness,{chatId:new URLSearchParams(location.search).get("chatId"),managedAgentId:null}));';
 const html='<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div>'
  +'<script>'+reactScripts+'</script><script>'+code+'</script></body></html>';
 const browser=await chromium.launch({
  executablePath:process.env.KATIE_TEST_CHROMIUM||await bundledChromium.executablePath(),
  args:bundledChromium.args,headless:true
 });
 try{
  const page=await browser.newPage();
  const errors=[],posts=[],requests=[];let stage=0,blockPrice=false,corruptQuote=false,denyValidator=false;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://localhost/**',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.pathname==='/owner-ui')return route.fulfill({contentType:'text/html',body:html});
   assert.equal(url.pathname,'/api/projects/task4a-postpaid-continuation',
    'The generic owner API must not be contacted by the original Task 4A UI');
   assert.equal(request.headers().authorization,'Bearer synthetic-owner');
   requests.push({method:request.method(),path:url.pathname});
   let body;
   if(request.method()==='GET'){
    assert.equal(url.searchParams.get('chatId'),originalChat);
    body=blockPrice?{state:'blocked_authority',reason:'fresh_official_model_pricing_required'}:
     stage===0?{state:'requires_owner_limits',reason:'explicit_owner_limits_required',evidence:{settledCalls:4,settledTokens:49620}}:
     stage===3?{state:'paid_authorized_pending_dispatch',authorityReceiptId:'fixture-receipt',
       redispatchReceiptId:'redispatch-receipt',paidReceiptId:'paid-receipt',dispatched:false,noAutomaticRetry:true}:
     {state:'pending_redispatch',ready:true,nextAction:'approveRedispatch',digest:'b'.repeat(64),authorityReceiptId:'fixture-receipt',proposal:{ownerId:'fixture-owner'}};
   }else{
    assert.equal(request.method(),'POST');
    const payload=request.postDataJSON();posts.push(payload);
    assert.deepEqual(payload.limits,expectedLimits);
    if(payload.action==='previewAuthority'){
     assert.equal(stage,0);
     if(denyValidator)return route.fulfill({status:409,contentType:'application/json',
      body:JSON.stringify({error:'Authoritative state changed or authentication failed. No consent assumed.'})});
     body={ready:true,digest:sha,proposal:{ownerId:'fixture-owner',nativeLimits:corruptQuote?{...expectedLimits,cumulativeTokens:289621}:expectedLimits,settledCalls:4,settledTokens:49620}};
    }else if(payload.action==='approveAuthority'){
     assert.equal(stage,0);
     assert.equal(payload.confirm,true);
     assert.equal(payload.digest,sha);
     stage=1;
     body={accepted:true,stage:'authority',dispatched:false,paidInferenceAuthorized:false,newPaidCalls:0,receiptId:'fixture-receipt'};
    }else{
     assert.fail('Preview and authority must never submit redispatch or paid inference');
    }
   }
   return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto('http://localhost/owner-ui?chatId='+originalChat);
  const region=page.getByRole('region',{name:'Task 4A postpaid same-task continuation'});
  try{await region.waitFor({timeout:12000});}
  catch(e){assert.fail('Task 4A owner panel not mounted: '+JSON.stringify({
   errors,body:await page.locator('body').innerText().catch(()=>null),
   requests,pageUrl:page.url(),root:await page.locator('#root').innerHTML().catch(()=>null)
  })+'; original error: '+String(e));}
  assert.equal(await page.getByTestId('generic-owner-approval').count(),0);
  assert.equal(await page.getByRole('button',{name:'Approve exactly this amendment'}).count(),0);
  // Katie prepares the exact historical limits without asking the owner to type.
  assert.equal(await region.locator('input').count(),0,'No manual financial-entry form');
  await region.getByText('Katie-prepared limits — no data entry').waitFor();
  await page.getByRole('button',{name:'Authorize these exact limits — NO dispatch or paid inference'}).waitFor();
  assert.deepEqual(posts.map(x=>x.action),['previewAuthority'],
   'Mount may only make an authenticated, read-only quote');
  assert.equal(stage,0,'Preview must not create any approval or dispatch');
  await page.getByRole('button',{name:'Authorize these exact limits — NO dispatch or paid inference'}).click();
  await page.getByRole('button',{name:'Approve original issue redispatch ONLY (no inference)'}).waitFor();
  assert.deepEqual(posts.map(x=>x.action),['previewAuthority','approveAuthority']);
  assert.equal(posts.some(x=>x.action==='approvePaidInference'||x.action==='approveRedispatch'),false);
  assert.ok(requests.every(x=>x.path==='/api/projects/task4a-postpaid-continuation'));
  await page.goto('http://localhost/owner-ui?chatId='+otherChat);
  await page.getByTestId('generic-owner-approval').waitFor();
  assert.equal(await page.getByRole('region',{name:'Task 4A postpaid same-task continuation'}).count(),0);
  // Stale official pricing is a hard stop, not an invitation to invent limits.
  stage=0;blockPrice=true;
  const previewCount=posts.length;
  await page.goto('http://localhost/owner-ui?chatId='+originalChat);
  await page.getByText('fresh_official_model_pricing_required').waitFor();
  assert.equal(await page.getByRole('button',{name:'Authorize these exact limits — NO dispatch or paid inference'}).count(),0);
  assert.equal(posts.length,previewCount,'No quote or payment attempt under stale pricing');
  // A contradictory server quote must never enable authorization either.
  blockPrice=false;corruptQuote=true;
  await page.goto('http://localhost/owner-ui?chatId='+originalChat);
  await page.getByText('Exact preapproved limits could not be quoted safely').waitFor();
  assert.equal(await page.getByRole('button',{name:'Authorize these exact limits — NO dispatch or paid inference'}).count(),0);
  // Real production 42501 -> HTTP 403 was hidden by the server API. Refresh
  // must re-request only a non-executing quote and clear the stale error.
  corruptQuote=false;denyValidator=true;
  await page.goto('http://localhost/owner-ui?chatId='+originalChat);
  await page.getByText('Authoritative state changed or authentication failed. No consent assumed.').waitFor();
  assert.equal(await page.getByRole('button',{name:'Authorize these exact limits — NO dispatch or paid inference'}).count(),0);
  const beforeRefresh=posts.filter(p=>p.action==='approveAuthority').length;
  denyValidator=false;
  await page.getByRole('button',{name:'Refresh owner approval status'}).click();
  await page.getByRole('button',{name:'Authorize these exact limits — NO dispatch or paid inference'}).waitFor();
  assert.equal(await page.getByText('Authoritative state changed or authentication failed. No consent assumed.').count(),0);
  assert.equal(posts.filter(p=>p.action==='approveAuthority').length,beforeRefresh,
   'Retrying quote must never retry financial consent');
  // Once the paid receipt exists but the original issue was not dispatched,
  // the owner must NOT see a second paid-consent button (the production bug).
  stage=3;const priorPosts=posts.length;
  await page.goto('http://localhost/owner-ui?chatId='+originalChat);
  await page.getByText('The bounded PAID execution consent is already recorded.',{exact:false}).waitFor();
  assert.equal(await page.getByRole('button',{name:/Separately authorize bounded PAID execution/}).count(),0);
  assert.equal(await page.getByRole('button',{name:/Approve original issue redispatch/}).count(),0);
  await page.getByRole('button',{name:'Refresh owner approval status'}).click();
  await page.getByText('The bounded PAID execution consent is already recorded.',{exact:false}).waitFor();
  assert.equal(posts.length,priorPosts,'Refresh never replays an already-recorded owner decision');
  assert.deepEqual(errors,[]);
  console.log('TASK4A_ACTUAL_APPROVAL_UI_BROWSER_PASS: auto quote, denied preview recovery, paid receipt no replay, zero manual entry');
 }finally{await browser.close();}
});
