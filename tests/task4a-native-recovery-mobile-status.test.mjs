import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import ts from "typescript";
import {chromium} from "playwright-core";
import bundledChromium from "@sparticuz/chromium";

test("Task 4A native approval keeps its success visible after the proposal disappears on mobile",{timeout:90000},async()=>{
 const browser=await chromium.launch({executablePath:process.env.KATIE_TEST_CHROMIUM||await bundledChromium.executablePath(),args:bundledChromium.args,headless:true});
 try{
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const page=await context.newPage(),errors=[];page.on("pageerror",e=>errors.push(e.message));
  const code=ts.transpileModule(readFileSync("components/task4a-native-recovery-approval.tsx","utf8"),{
   compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}
  }).outputText;
  const scripts=["react/umd/react.production.min.js","react-dom/umd/react-dom.production.min.js"].map(p=>readFileSync("node_modules/"+p,"utf8"));
  const chat="e53defeb-16eb-457e-aa07-435141165ee8",digest="a".repeat(64);
  const proposal={ready:true,digest,proposal:{
   taskId:"d0e41ff5-149e-4319-9e65-dcc605fb75da",oldApprovalId:"ddccc7a1-743f-4031-8ecd-a6926568ca98",
   continuationId:"02951ce8-e502-4fe0-852c-95a69c877b78",model:"gpt-5.3-codex",
   limits:{cumulativeTokens:180000,developmentCalls:12,assessmentCalls:4,completionCalls:4,ceilingMicrousd:2520000},
   replacementDeadline:"2026-11-05T16:49:08.043Z",originalNativeDeadline:"2026-11-04T16:17:55.386Z"
  }};
  const html='<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>'
   +'<div style="height:420px;max-width:390px;overflow:hidden;display:flex;flex-direction:column">'
   +'<div id="approval-stack" style="min-height:0;overflow-y:auto;touch-action:pan-y;flex:1">'
   +'<div style="height:300px">Earlier cards</div><div id="root"></div></div></div>'
   +'<script>'+scripts.join("\n")+'</script><script>const exports={};'
   +'const require=name=>name==="react"?React:name==="react/jsx-runtime"?{Fragment:React.Fragment,jsx:(t,p,k)=>React.createElement(t,{...p,key:k}),jsxs:(t,p,k)=>React.createElement(t,{...p,key:k})}:{ownerSessionBearer:async()=> "synthetic-owner"};'
   +code+';ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(exports.Task4aNativeRecoveryApproval,{chatId:'+JSON.stringify(chat)+'}));</script></body></html>';
  let recovered=false,posts=0;
  await page.route("http://localhost/**",async route=>{
   const req=route.request(),path=new URL(req.url()).pathname;
   if(!path.startsWith("/api/"))return route.fulfill({contentType:"text/html",body:html});
   assert.equal(req.headers().authorization,"Bearer synthetic-owner");
   if(req.method()==="POST"){
    assert.deepEqual(req.postDataJSON(),{confirm:true,proposalDigest:digest});
    posts++;recovered=true;
    return route.fulfill({contentType:"application/json",body:JSON.stringify({accepted:true,receiptId:"verified-receipt"})});
   }
   return route.fulfill({contentType:"application/json",
    body:JSON.stringify(recovered?{ready:false,recovered:true,recordedAt:"2026-11-05T13:43:04Z"}:proposal)});
  });
  await page.goto("http://localhost/");
  const button=page.getByRole("button",{name:"Approve exact bounded Task 4A native recovery"});await button.waitFor();await button.click();
  const message=page.getByRole("status");await message.waitFor();
  assert.match(await message.innerText(),/Native recovery was approved and saved/);
  assert.match(await message.innerText(),/does not authorize paid execution/);
  assert.equal(await button.count(),0,"approval button disappears after consent saved");
  assert.equal(posts,1,"only one owner action");
  await page.reload();
  await page.getByRole("status").waitFor();
  assert.match(await page.getByRole("status").innerText(),/Native recovery was approved and saved/);
  assert.equal(await button.count(),0,"reload cannot offer the saved approval again");
  assert.equal(posts,1,"reload must not create duplicate approval");
  await page.waitForFunction(()=>{
   const m=document.querySelector('[role="status"]'),c=document.querySelector("#approval-stack");
   if(!m||!c)return false;
   const r=m.getBoundingClientRect(),container=c.getBoundingClientRect();
   return r.top>=container.top&&r.bottom<=container.bottom;
  },null,{timeout:5000});
  assert.deepEqual(errors,[]);
  await context.close();
 }finally{await browser.close();}
});
