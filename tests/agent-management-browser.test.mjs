import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import ts from 'typescript';
import {chromium} from 'playwright-core';
import bundledChromium from '@sparticuz/chromium';

// The actual React page, actual Chromium, and local fixture APIs only. No deployment or external providers.
test('Agents UI: create/edit/archive, saved approval, durable pending status, reload and errors',{timeout:90000},async()=>{
 const executablePath=process.env.KATIE_TEST_CHROMIUM||await bundledChromium.executablePath();
 const browser=await chromium.launch({executablePath,args:bundledChromium.args,headless:true});
 try {
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const agents=[],tasks=[];let executionCount=0,fail=false,loseContinuation=true;const turns=new Map(),submissions=[];
  const code=ts.transpileModule(readFileSync('app/agents/page.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  const scripts=[readFileSync('node_modules/react/umd/react.production.min.js','utf8'),readFileSync('node_modules/react-dom/umd/react-dom.production.min.js','utf8')];
  const html=`<!doctype html><html><body><div id="root"></div><script>${scripts.join('\n')}</script><script>
  const exports={}; const require=name=>name==='react'?React:name==='react/jsx-runtime'?{Fragment:React.Fragment,jsx:(type,p,key)=>React.createElement(type,{...p,key}),jsxs:(type,p,key)=>React.createElement(type,{...p,key})}:name==='next/link'?{__esModule:true,default:p=>React.createElement('a',p)}:{};
  ${code}
  ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(exports.default));</script></body></html>`;
  await page.route('http://localhost/**',async route=>{
   const request=route.request(),url=new URL(request.url()),body=request.postDataJSON?.();
   if(!url.pathname.startsWith('/api/'))return route.fulfill({contentType:'text/html',body:html});
   const reply=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
   if(fail)return reply({error:'Fixture service unavailable'},503);
   if(url.pathname==='/api/agents'){
    if(request.method()==='POST'){
     let a=agents.find(a=>a.id===body.id);
     if(a)Object.assign(a,{config:body.config,archived:body.archive??false,version:a.version+1});
     else {a={id:randomUUID(),actor_id:randomUUID(),config:body.config,version:1,archived:false};agents.push(a);}
     return reply({agent:a});
    }return reply({agents});
   }
   if(url.pathname==='/api/admin/repos')return reply({repos:[]});
   if(url.pathname==='/api/agent-tasks'){
    if(request.method()==='GET')return reply(url.searchParams.has('id')?{task:tasks.find(t=>t.id===url.searchParams.get('id'))}:{tasks});
    if(body.action==='create'){
     const agent=agents.find(a=>a.id===body.agentId);
     const task={id:body.id,agent_id:agent.id,actor_id:agent.actor_id,chat_id:randomUUID(),snapshot:structuredClone(agent.config),definition_version:agent.version,kind:body.kind,initial_input:body.input,input:body.input,request_id:'agent:'+body.id,status:'draft',repository_full_name:null,external:{}};tasks.push(task);return reply({task});
    }
    const task=tasks.find(t=>t.id===body.id);
    if(body.action==='continue'){
     submissions.push(body);
     let receipt=turns.get(body.turnId);
     if(!receipt){assert.equal(body.expectedRequestId,task.request_id);receipt={turn_id:body.turnId,request_id:'agent:'+randomUUID(),input:body.message,base_request_id:body.expectedRequestId};turns.set(body.turnId,receipt);Object.assign(task,{request_id:receipt.request_id,input:body.message,status:'running'});}
     if(loseContinuation){loseContinuation=false;return route.abort('failed');}
     return reply({task,continuation:receipt});
    }
    if(body.action==='start')task.status='running';return reply({task});
   }
   if(url.pathname==='/api/chat'){executionCount++;tasks[0].status='pending';tasks[0].output='Saved reviewed draft';tasks[0].details='Independent review needs clarification';return route.fulfill({contentType:'application/x-ndjson',body:'{"type":"content","text":"draft"}\n'});}
   return reply({error:'Unknown fixture route'},404);
  });
  await page.goto('http://localhost/agents');
  await page.getByText('No managed agents yet.',{exact:false}).waitFor();
  await page.getByLabel('Name',{exact:true}).fill('Writer');
  await page.getByLabel('Purpose, instructions and responsibilities').fill('Draft concise reports');
  await page.getByRole('button',{name:'Save agent',exact:true}).click();
  await page.getByRole('button',{name:'Edit Writer'}).waitFor();
  await page.getByLabel('Agent',{exact:true}).selectOption(agents[0].id);
  await page.getByLabel('Task instructions',{exact:true}).fill('Write a report');
  await page.getByRole('button',{name:'Save task for approval'}).click();
  await page.getByRole('button',{name:'Start saved task'}).waitFor();assert.equal(executionCount,0);
  await page.getByRole('button',{name:'Edit Writer'}).click();
  await page.getByLabel('Purpose, instructions and responsibilities').fill('Changed instructions');
  await page.getByRole('button',{name:'Save agent',exact:true}).click();
  assert.equal(tasks[0].snapshot.instructions,'Draft concise reports');
  await page.getByRole('button',{name:'Start saved task'}).click();
  await page.getByRole('heading',{name:'Saved task · pending'}).waitFor();assert.equal(executionCount,1);
  await page.reload();await page.getByText('Saved reviewed draft',{exact:true}).waitFor();
  assert.equal(executionCount,1);assert.equal(await page.getByRole('button',{name:'Start saved task'}).count(),0);
  await page.getByLabel('Continue in this task’s conversation').fill('Include the requested clarification');
  await page.getByRole('button',{name:'Send continuation'}).click();
  await page.getByRole('button',{name:'Retry saved continuation'}).waitFor();
  await page.reload();await page.getByRole('button',{name:'Retry saved continuation'}).waitFor();
  assert.equal(executionCount,1);assert.equal(turns.size,1);
  await page.getByRole('button',{name:'Retry saved continuation'}).click();
  await page.getByRole('heading',{name:'Saved task · pending'}).waitFor();
  assert.equal(executionCount,2);assert.equal(turns.size,1);assert.equal(submissions.length,2);
  assert.deepEqual(submissions[0],submissions[1]);
  await page.reload();await page.getByText('Saved reviewed draft',{exact:true}).waitFor();assert.equal(executionCount,2);
  assert.equal(await page.getByRole('button',{name:'Retry saved continuation'}).count(),0);
  await page.getByRole('button',{name:'Archive Writer'}).click();await page.getByText('Writer (archived)',{exact:true}).waitFor();
  fail=true;await page.getByRole('button',{name:'Refresh status'}).click();await page.getByRole('alert').waitFor();assert.match(await page.getByRole('alert').innerText(),/unavailable/);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
