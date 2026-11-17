import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {chromium} from 'playwright-core';
import bundled from '@sparticuz/chromium';
for(const handoff of [false,true])test('Chromium failed-verifier separate decisions, no dispatch on rendering; release handoff='+handoff,{timeout:90000},async()=>{
 const js=ts.transpileModule(readFileSync('components/task4a-verifier-recovery-approval.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const react=['react/umd/react.production.min.js','react-dom/umd/react-dom.production.min.js'].map(p=>readFileSync('node_modules/'+p,'utf8')).join('\n');
 const code='const exports={};const require=n=>n==="react"?React:n==="react/jsx-runtime"?{jsx:(t,p,k)=>React.createElement(t,{...p,key:k}),jsxs:(t,p,k)=>React.createElement(t,{...p,key:k}),Fragment:React.Fragment}:{ownerSessionBearer:async()=>"test-owner"};'+js+';ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(exports.Task4aVerifierRecoveryApproval));';
 const browser=await chromium.launch({executablePath:process.env.KATIE_TEST_CHROMIUM||await bundled.executablePath(),args:bundled.args,headless:true});
 try{
 const page=await browser.newPage(),actions=handoff?['handoff','dispatch']:['authority','replacement','inference','dispatch'],labels=handoff?['Bind existing approvals to this qualified release','Dispatch this replacement once']:['Approve this capacity transfer and deadline decision','Authorize verification-first replacement','Authorize bounded paid review','Dispatch this replacement once'],posts=[],errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('http://localhost/**',async route=>{
 const r=route.request();if(new URL(r.url()).pathname==='/owner')return route.fulfill({contentType:'text/html',body:'<html><body><div id="root"></div><script>'+react+'</script><script>'+code+'</script></body></html>'});
 assert.equal(r.headers().authorization,'Bearer test-owner');
 if(r.method()==='POST'){const b=r.postDataJSON();assert.deepEqual(b,{action:actions[posts.length],digest:'a'.repeat(64),confirm:true});posts.push(b.action);return route.fulfill({json:{accepted:true,dispatchAccepted:posts.length===actions.length}});}
 return route.fulfill({json:posts.length===actions.length?{state:'claimed_once'}:{state:'pending',ready:true,action:actions[posts.length],digest:'a'.repeat(64),proposal:{guaranteedCompletion:false}}});
 });
 await page.goto('http://localhost/owner');await page.getByRole('button',{name:labels[0],exact:true}).waitFor();assert.equal(posts.length,0);
 assert.equal(await page.locator('input').count(),0,'No manual financial entry');
 if(handoff){await page.getByText(/This release handoff preserves the existing deadline/).waitFor();assert.equal(await page.getByText(/explicitly renews it for four hours/).count(),0);}
 for(let i=0;i<labels.length;i++){assert.equal(posts.length,i);await page.getByRole('button',{name:labels[i],exact:true}).click();if(i<labels.length-1)await page.getByRole('button',{name:labels[i+1],exact:true}).waitFor();}
 await page.getByText('claimed_once. No automatic retry.',{exact:true}).waitFor();assert.deepEqual(posts,actions);assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
