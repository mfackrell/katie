import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {randomUUID} from 'node:crypto';import ts from 'typescript';import {chromium} from 'playwright-core';import bundledChromium from '@sparticuz/chromium';
test('mission UI saves an approved team, starts only once, reloads completed background work and stops a draft',{timeout:90000},async()=>{
 const browser=await chromium.launch({executablePath:process.env.KATIE_TEST_CHROMIUM||await bundledChromium.executablePath(),args:bundledChromium.args,headless:true});
 try{
  const context=await browser.newContext({viewport:{width:390,height:844}}),agents=[{id:randomUUID(),config:{name:'Researcher'},archived:false},{id:randomUUID(),config:{name:'Analyst'},archived:false}],missions=[],requests=[];let failures=false;
  const code=ts.transpileModule(readFileSync('components/missions-panel.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  const html=`<!doctype html><html><body><div id='root'></div><script>${readFileSync('node_modules/react/umd/react.production.min.js','utf8')}\n${readFileSync('node_modules/react-dom/umd/react-dom.production.min.js','utf8')}</script><script>const exports={};const require=n=>n==='react'?React:n==='react/jsx-runtime'?{Fragment:React.Fragment,jsx:(t,p,k)=>React.createElement(t,{...p,key:k}),jsxs:(t,p,k)=>React.createElement(t,{...p,key:k})}:n==='react-markdown'?{__esModule:true,default:p=>React.createElement('div',null,p.children)}:n==='remark-gfm'?{__esModule:true,default:()=>{}}:{};${code};ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(exports.MissionsPanel,{agents:${JSON.stringify(agents)},repos:[]}));</script></body></html>`;
  await context.route('http://localhost/**',async route=>{
   const r=route.request(),u=new URL(r.url());const reply=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
   if(!u.pathname.startsWith('/api/'))return route.fulfill({contentType:'text/html',body:html});
   assert.equal(u.pathname,'/api/missions','UI must not call a model/worker endpoint');
   if(failures)return reply({error:'Fixture mission service unavailable'},503);
   if(r.method()==='GET')return reply(u.searchParams.has('id')?{mission:missions.find(m=>m.id===u.searchParams.get('id')),jobs:[]}:{missions});
   const b=r.postDataJSON();requests.push(b);if(b.action==='create'){const m={id:b.id,objective:b.objective,team:structuredClone(agents),status:'draft',max_calls:12,calls:0,token_allowance:60000,reserved_tokens:0,actual_tokens:0,max_minutes:b.minutes,result:null};missions.push(m);return reply({mission:m});}
   const m=missions.find(m=>m.id===b.id);if(b.action==='start')m.status='running';if(b.action==='stop')m.status='stopped';return reply({mission:m});
  });
  let page=await context.newPage();const errors=[];context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://localhost/agents');await page.getByLabel('Mission objective').fill('Evaluate a service offer with evidence and economics');
  await page.getByLabel('Researcher',{exact:true}).check();await page.getByLabel('Analyst',{exact:true}).check();
  await page.getByRole('button',{name:'Save mission for approval'}).click();await page.getByRole('button',{name:'Start background mission'}).waitFor();assert.equal(requests.length,1);
  await page.getByRole('button',{name:'Start background mission'}).click();await page.getByRole('heading',{name:'Mission · running'}).waitFor();assert.equal(requests.length,2);
  const url=page.url();await page.close();Object.assign(missions[0],{status:'completed',calls:7,actual_tokens:4321,result:'The independently checked recommendation.'});
  page=await context.newPage();await page.goto(url);await page.getByLabel('Mission deliverable').waitFor();assert.match(await page.getByLabel('Mission deliverable').innerText(),/independently checked/);assert.equal(requests.length,2,'reopening does not start another mission');
  await page.getByLabel('Mission objective').fill('A second mission');await page.getByLabel('Researcher',{exact:true}).check();await page.getByRole('button',{name:'Save mission for approval'}).click();await page.getByRole('heading',{name:'Mission · draft'}).waitFor();await page.getByRole('button',{name:'Stop mission'}).click();await page.getByRole('heading',{name:'Mission · stopped'}).waitFor();
  assert.equal(missions[1].status,'stopped');assert.equal(requests.filter(r=>r.action==='start').length,1);
  failures=true;await page.getByRole('button',{name:'Refresh missions'}).click();await page.getByRole('alert').waitFor();assert.match(await page.getByRole('alert').innerText(),/unavailable/);assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
