// Real owner component -> real route -> disposable PostgreSQL. No API result mock.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {NextRequest} from 'next/server.js';
import {chromium} from 'playwright-core';
import bundledChromium from '@sparticuz/chromium';
import config from '../../config/benchmark-715-production-qualification.json' with {type:'json'};
export async function integratedOwnerBrowser(route,run){
 const browser=await chromium.launch({executablePath:process.env.KATIE_TEST_CHROMIUM||await bundledChromium.executablePath(),args:bundledChromium.args,headless:true});
 const exchanges=[],errors=[];
 try{
  const page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));
  const code=ts.transpileModule(readFileSync('components/lifecycle-owner-approval.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const scripts=['react/umd/react.production.min.js','react-dom/umd/react-dom.production.min.js'].map(p=>readFileSync('node_modules/'+p,'utf8'));
  const html=`<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script>${scripts.join('\n')}</script><script>const exports={};const require=name=>name==='react'?React:name==='react/jsx-runtime'?{Fragment:React.Fragment,jsx:(t,p,k)=>React.createElement(t,{...p,key:k}),jsxs:(t,p,k)=>React.createElement(t,{...p,key:k})}:{ownerSessionBearer:async()=> 'task2c-synthetic-owner'};${code};ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(exports.LifecycleOwnerApproval));</script></body></html>`;
  await page.route('**/*',async transport=>{
   const r=transport.request();assert.equal(new URL(r.url()).origin,config.productionUrl,'Production network is intercepted, never contacted');
   if(new URL(r.url()).pathname==='/task2c-synthetic-owner')return transport.fulfill({contentType:'text/html',body:html});
   assert.equal(new URL(r.url()).pathname,'/api/projects/lifecycle-approval');assert.ok(['GET','POST'].includes(r.method()));
   const headers=await r.allHeaders();const request=new NextRequest(r.url(),{method:r.method(),headers,...(r.method()==='POST'?{body:r.postData()}:{} )});
   const response=await route[r.method()](request),body=await response.text();exchanges.push({method:r.method(),request:r.postData()?JSON.parse(r.postData()):null,status:response.status,response:JSON.parse(body)});
   await transport.fulfill({status:response.status,contentType:'application/json',body});
  });
  await page.goto(config.productionUrl+'/task2c-synthetic-owner');
  await page.getByRole('button',{name:'Approve exactly this amendment'}).waitFor({timeout:15000});
  await run(page,exchanges);
  assert.deepEqual(errors,[]);return {exchanges,errors,visibleText:await page.locator('body').innerText()};
 }finally{await browser.close();}
}
