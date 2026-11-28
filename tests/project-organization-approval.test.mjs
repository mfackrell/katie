import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {chromium} from 'playwright-core';
import bundled from '@sparticuz/chromium';
import {modules} from './helpers/load-project-modules.mjs';

const actorId=randomUUID(), chatId=randomUUID(), projectId=randomUUID();
const project={id:projectId,actor_id:actorId,chat_id:chatId,organization_version:1,status:'running',phase:'research',
 objective:'Build a saved checklist — no external services.',clarifications:'Only inside the existing application.',
 repository_id:randomUUID(),repository_full_name:'example/existing-app',deadline:'2099-01-01T12:00:00Z',max_cycles:3,max_missions:12,token_allowance:200000};
const digest=p=>createHash('sha256').update(p.objective+p.clarifications).digest('hex');
const terms=p=>({objective:p.objective,clarifications:p.clarifications,repositoryId:p.repository_id,repository:p.repository_full_name,deadline:p.deadline,
 limits:{codingJobs:p.max_cycles,missions:p.max_missions,modelTokens:p.token_allowance}});

function fixture(){
 const state={project:{...project},owner:true,provider:false,authority:null,readError:null,reads:0,writes:[],changed:false};
 const load=modules({
  '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async r=>state.owner&&r.headers.get('authorization')==='Bearer synthetic-owner'&&(r.method==='GET'||r.headers.get('origin')===new URL(r.url).origin)},
  '@/lib/data/persistence-store':{getChatById:async id=>id===chatId?{actorId}:null,getMessages:async()=>[]},
  '@/lib/projects/store':{projectForChat:async()=>state.project,projectRpc:async name=>{assert.equal(name,'project_provider_mode');return state.provider;}},
  '@/lib/projects/recovery-budget':{recoveryResourceProposal:async()=>null},
  '@/lib/executive/delivery':{hasPendingExecutiveDelivery:async()=>false},
  '@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>({from(table){assert.equal(table,'project_organization_authority');return {select(columns){assert.equal(columns,'project_id');return {eq(column,id){assert.equal(column,'project_id');assert.equal(id,projectId);return {async maybeSingle(){state.reads++;return {data:state.authority,error:state.readError};}};}};}};}})},
  '@/lib/missions/store':{rpc:async(name,args)=>{
   assert.equal(name,'project_org_authorize');
   if(state.changed||args.p_objective_hash!==digest(state.project))throw Error('Changed objective');
   assert.deepEqual(JSON.parse(JSON.stringify(args.p_terms)),terms(state.project));
   state.writes.push(args);state.authority={project_id:projectId};return true;
  }},
 });
 const getRoute=load('@/app/api/projects/route'),postRoute=load('@/app/api/projects/organization/route');
 const get=async(bearer='synthetic-owner',chat=chatId)=>{
  const r=new Request('http://localhost/api/projects?actorId='+actorId+'&chatId='+chat,{headers:bearer?{Authorization:'Bearer '+bearer}:{}});
  r.nextUrl=new URL(r.url);return getRoute.GET(r);
 };
 const post=async(body,origin='http://localhost')=>postRoute.POST(new Request('http://localhost/api/projects/organization',{
  method:'POST',headers:{Authorization:'Bearer synthetic-owner',Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)}));
 return {state,get,post};
}

test('ordinary project GET offers exact saved terms only to the authenticated owner, with no mutation',async()=>{
 const {state,get}=fixture();
 for(const bearer of [null,'different-owner'])assert.equal((await (await get(bearer)).json()).organizationApproval,null);
 assert.equal(state.reads,0);assert.equal((await get('synthetic-owner',randomUUID())).status,404);
 const offer=(await (await get()).json()).organizationApproval;
 assert.deepEqual(offer,{projectId,objectiveHash:digest(project),objective:project.objective,clarifications:project.clarifications,
  repositoryId:project.repository_id,repository:project.repository_full_name,deadline:project.deadline,limits:{codingJobs:3,missions:12,modelTokens:200000}});
 state.authority={project_id:projectId};assert.equal((await (await get()).json()).organizationApproval,null);
 state.authority=null;state.readError={message:'unavailable'};assert.equal((await get()).status,503);state.readError=null;
 for(const status of ['completed','stopped','failed']){state.project={...project,status};assert.equal((await (await get()).json()).organizationApproval,null);}
 state.project={...project,deadline:'2000-01-01T00:00:00Z'};assert.equal((await (await get()).json()).organizationApproval,null);
 state.project={...project,organization_version:0};assert.equal((await (await get()).json()).organizationApproval,null);
 // Provider-controlled recovery retains its own existing flow, never this generic offer.
 state.project={...project};state.provider=true;state.owner=false;
 assert.equal((await (await get()).json()).organizationApproval,null);assert.deepEqual(state.writes,[]);
});

test('decimal budget conversion is exact and never supplies a default',()=>{
 const parse=modules()('@/lib/projects/organization-approval').projectBudgetMicrousd;
 for(const [input,expected] of [['0.000001',1],['1.000001',1000001],['0.29',290000],['999.999999',999999999],['1000',1000000000]])assert.equal(parse(input),expected);
 for(const input of ['', '0','0.000000','-1','1e2','1,000',' 1','1 ','01','Infinity','NaN','1.0000001','1000.000001','1001','1.','.5'])assert.equal(parse(input),null,input);
});

test('existing POST forwards the complete displayed snapshot and rejects changed terms with the same objective',async()=>{
 const {state,post}=fixture();
 const body={projectId,objectiveHash:digest(project),autonomousExecution:true,ceilingMicrousd:1000001,perCallMicrousd:1,terms:terms(project)};
 for(const change of [{deadline:'2099-01-02T12:00:00Z'},{repository_full_name:'example/different-app'},
  {repository_id:randomUUID()},{max_missions:13},{max_cycles:4},{token_allowance:201000}]){
  state.project={...project,...change};assert.equal(digest(state.project),body.objectiveHash);
  assert.equal((await post(body)).status,409);assert.equal(state.writes.length,0);
 }
 state.project={...project};assert.equal((await post(body)).status,200);
 assert.deepEqual(JSON.parse(JSON.stringify(state.writes[0].p_terms)),terms(project));
});

test('existing owner API still enforces same-origin owner authentication and explicit objective-bound input',async t=>{
 const previousFetch=globalThis.fetch,keys=['VERCEL_ENV','NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_SUPABASE_ANON_KEY','KATIE_OWNER_AUTH_USER_ID'];
 const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));const owner=randomUUID();
 Object.assign(process.env,{VERCEL_ENV:'production',NEXT_PUBLIC_SUPABASE_URL:'https://synthetic-auth.test',NEXT_PUBLIC_SUPABASE_ANON_KEY:'synthetic-key',KATIE_OWNER_AUTH_USER_ID:owner});
 t.after(()=>{globalThis.fetch=previousFetch;for(const k of keys){if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k];}});
 let authReads=0,writes=0,identity=owner;
 globalThis.fetch=async url=>{assert.equal(url,'https://synthetic-auth.test/auth/v1/user');authReads++;return Response.json({id:identity});};
 const {POST}=modules({'@/lib/missions/store':{rpc:async(name,args)=>{assert.equal(name,'project_org_authorize');assert.equal(args.p_owner,owner);writes++;return true;}}})('@/app/api/projects/organization/route');
 const body={projectId,objectiveHash:digest(project),autonomousExecution:true,ceilingMicrousd:1000001,perCallMicrousd:1,terms:terms(project)};
 const request=(payload=body,origin='https://synthetic.test',bearer='synthetic-owner')=>new Request('https://synthetic.test/api/projects/organization',{method:'POST',headers:{Origin:origin,...(bearer?{Authorization:'Bearer '+bearer}:{}),'Content-Type':'application/json'},body:JSON.stringify(payload)});
 assert.equal((await POST(request(body,'https://external.test'))).status,403);assert.equal(authReads,0);
 assert.equal((await POST(request(body,'https://synthetic.test',null))).status,403);assert.equal(authReads,0);
 identity=randomUUID();assert.equal((await POST(request())).status,403);identity=owner;
 assert.equal((await POST(request({...body,autonomousExecution:false}))).status,400);
 assert.equal((await POST(request({...body,ceilingMicrousd:undefined}))).status,400);assert.equal(writes,0);
 for(const snapshot of [undefined,null,{}, {...terms(project),extra:true},{...terms(project),deadline:'bad'}])assert.equal((await POST(request({...body,terms:snapshot}))).status,400);
 assert.equal((await POST(request())).status,200);assert.equal(writes,1);
});

test('real chat control requires explicit amounts and consent, resets on changes, and submits once',{timeout:90000},async()=>{
 const {state,get,post}=fixture();const offer=(await (await get()).json()).organizationApproval;
 const transpile=s=>ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const panel=readFileSync('components/chat-panel.tsx','utf8'),start=panel.indexOf('{organizationApproval?.chatId===chatId'),end=panel.indexOf('{resourceRecovery?.chatId===chatId',start);
 assert.ok(start>0&&end>start);assert.match(panel,/setOrganizationApproval\(p\.organizationApproval\?\{chatId,offer:p\.organizationApproval\}:null\)/);
 const harness=transpile('function Harness({organizationApproval,chatId,managedAgentId}){const loading=false;const setGameTrialRefresh=fn=>{window.refreshes=fn(window.refreshes)};return <div data-testid="harness">'+panel.slice(start,end)+'</div>}');
 const control=transpile(readFileSync('components/project-organization-approval.tsx','utf8')),amounts=transpile(readFileSync('lib/projects/organization-approval.ts','utf8'));
 const react=['react/umd/react.production.min.js','react-dom/umd/react-dom.production.min.js'].map(f=>readFileSync('node_modules/'+f,'utf8')).join('\n');
 const browser=await chromium.launch({executablePath:process.env.KATIE_TEST_CHROMIUM||await bundled.executablePath(),args:bundled.args,headless:true});
 try{
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const code=`const jsxRuntime={Fragment:React.Fragment,jsx:(t,p,k)=>React.createElement(t,{...p,key:k}),jsxs:(t,p,k)=>React.createElement(t,{...p,key:k})};
   const load=(code,extra={})=>{const exports={};const require=n=>n==='react'?React:n==='react/jsx-runtime'?jsxRuntime:n==='@/lib/tools/browser-owner-session'?{ownerSessionBearer:async()=>window.bearer}:extra[n]||{};new Function('exports','require',code)(exports,require);return exports;};
   window.bearer='synthetic-owner';window.refreshes=0;
   const {ProjectOrganizationApproval}=load(${JSON.stringify(control)},{'@/lib/projects/organization-approval':load(${JSON.stringify(amounts)})});
   const Harness=(()=>{const exports={};const require=n=>jsxRuntime;${harness};return Harness;})();
   const root=ReactDOM.createRoot(document.getElementById('root'));window.offer=${JSON.stringify(offer)};
   window.render=(chat=${JSON.stringify(chatId)},managed=null)=>root.render(React.createElement(Harness,{organizationApproval:window.offer?{chatId:${JSON.stringify(chatId)},offer:window.offer}:null,chatId:chat,managedAgentId:managed}));window.render();`;
  await page.route('http://localhost/**',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(url.pathname==='/control')return route.fulfill({contentType:'text/html',body:'<html><meta charset="utf-8"><div id="root"></div><script>'+react+'</script><script>'+code+'</script></html>'});
   assert.equal(url.pathname,'/api/projects/organization');assert.equal(req.headers().authorization,'Bearer synthetic-owner');
   const response=await post(req.postDataJSON(),req.headers().origin);await route.fulfill({status:response.status,json:await response.json()});
  });
  await page.goto('http://localhost/control');const button=page.getByRole('button',{name:'Authorize project',exact:true});await button.waitFor();
  const total=page.getByRole('textbox',{name:'Total project budget (USD)',exact:true}),perCall=page.getByRole('textbox',{name:'Maximum per model call (USD)',exact:true}),checkbox=page.getByRole('checkbox');
  assert.equal(await total.inputValue(),'');assert.equal(await perCall.inputValue(),'');assert.equal(await checkbox.isChecked(),false);assert.equal(await button.isDisabled(),true);
  await total.fill('1.000001');await perCall.fill('2');assert.equal(await checkbox.isDisabled(),true);
  await perCall.fill('0.000001');await checkbox.check();assert.equal(await button.isEnabled(),true);
  await total.fill('2');assert.equal(await checkbox.isChecked(),false);
  await checkbox.check();await page.evaluate(()=>{window.offer={...window.offer,deadline:'2099-01-02T12:00:00Z'};window.render();});
  state.project.deadline='2099-01-02T12:00:00Z';
  await page.waitForFunction(()=>document.querySelector('input[type=text]').value==='');assert.equal(await checkbox.isChecked(),false);assert.equal(await button.isDisabled(),true);
  await total.fill('1.000001');await perCall.fill('0.000001');await checkbox.check();
  state.changed=true;await button.click();await page.getByRole('alert').waitFor();assert.equal(await checkbox.isChecked(),false);assert.equal(state.writes.length,0);
  state.changed=false;await checkbox.check();await page.evaluate(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent==='Authorize project');button.click();button.click();});
  await page.getByRole('status').filter({hasText:'Project authorization recorded.'}).waitFor();
  assert.equal(state.writes.length,1);assert.equal(state.writes[0].p_ceiling,1000001);assert.equal(state.writes[0].p_per_call,1);assert.equal(state.writes[0].p_objective_hash,digest(project));assert.equal(state.writes[0].p_autonomous,true);
  assert.equal(await page.evaluate(()=>window.refreshes),1);assert.equal((await (await get()).json()).organizationApproval,null);
  await page.evaluate(()=>window.render('different-chat'));assert.equal(await button.count(),0);
  await page.evaluate(chat=>window.render(chat,'worker'),chatId);assert.equal(await button.count(),0);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
