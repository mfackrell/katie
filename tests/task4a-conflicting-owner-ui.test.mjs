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
  const errors=[],posts=[],requests=[];let stage=0;
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
    body=stage===0
     ?{state:'requires_owner_limits',reason:'explicit_owner_limits_required',evidence:{settledCalls:4,settledTokens:49620}}
     :{state:'pending_redispatch',ready:true,nextAction:'approveRedispatch',digest:'b'.repeat(64),authorityReceiptId:'fixture-receipt',proposal:{ownerId:'fixture-owner'}};
   }else{
    assert.equal(request.method(),'POST');
    const payload=request.postDataJSON();posts.push(payload);
    assert.deepEqual(payload.limits,expectedLimits);
    if(payload.action==='previewAuthority'){
     assert.equal(stage,0);
     body={ready:true,digest:sha,proposal:{ownerId:'fixture-owner',nativeLimits:expectedLimits,settledCalls:4,settledTokens:49620}};
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
  await page.getByLabel('Total cumulative tokens').fill('289620');
  await page.getByLabel('Development tokens including completion').fill('229620');
  await page.getByLabel('Development calls including completion').fill('16');
  await page.getByLabel('Cumulative dollar ceiling, USD').fill('9');
  await page.getByLabel('Execution window, hours from approval').fill('4');
  await page.getByRole('button',{name:'Preview exact limits — no charges'}).click();
  await page.getByRole('button',{name:'Approve exactly this authority — NO dispatch'}).waitFor();
  assert.deepEqual(posts.map(x=>x.action),['previewAuthority']);
  await page.getByRole('button',{name:'Approve exactly this authority — NO dispatch'}).click();
  await page.getByRole('button',{name:'Approve original issue redispatch ONLY (no inference)'}).waitFor();
  assert.deepEqual(posts.map(x=>x.action),['previewAuthority','approveAuthority']);
  assert.equal(posts.some(x=>x.action==='approvePaidInference'||x.action==='approveRedispatch'),false);
  assert.ok(requests.every(x=>x.path==='/api/projects/task4a-postpaid-continuation'));
  await page.goto('http://localhost/owner-ui?chatId='+otherChat);
  await page.getByTestId('generic-owner-approval').waitFor();
  assert.equal(await page.getByRole('region',{name:'Task 4A postpaid same-task continuation'}).count(),0);
  assert.deepEqual(errors,[]);
  console.log('TASK4A_ACTUAL_APPROVAL_UI_BROWSER_PASS: original chat is postpaid-only; unrelated generic approval reachable; no dispatch or paid calls');
 }finally{await browser.close();}
});
