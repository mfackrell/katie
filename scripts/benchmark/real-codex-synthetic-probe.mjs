// Nonbillable synthetic Responses API qualification with a real Codex SDK.
// Synthetic text is scripted; no live model or provider credentials.
import {Codex} from '@openai/codex-sdk';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const root=mkdtempSync(join(tmpdir(),'codex-synthetic-'));
const home=join(root,'home'),state=join(home,'.codex'),repo=join(root,'repo');
mkdirSync(state,{recursive:true});mkdirSync(repo);
execFileSync('git',['init','-q',repo]);
const requests=[];
let remaining=5;
const server=createServer((req,res)=>{
 const chunks=[];req.on('data',c=>chunks.push(c));
 req.on('end',()=>{
  let body={};try{body=JSON.parse(Buffer.concat(chunks).toString());}catch{}
  requests.push({method:req.method,url:req.url,model:body.model,input:body.input});
  if(--remaining<0){res.writeHead(429,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'SYNTHETIC_BUDGET_EXHAUSTED',type:'insufficient_quota',code:'insufficient_quota'}}));return;}
  const id='resp_synthetic_'+requests.length;
  const headers={'content-type':'text/event-stream','cache-control':'no-cache'};
  res.writeHead(200,headers);
  const put=(type,payload)=>res.write('event: '+type+'\\ndata: '+JSON.stringify(payload)+'\\n\\n');
  const response={id,object:'response',created_at:1,model:body.model||'synthetic',status:'completed',output:[],usage:{input_tokens:3,output_tokens:2,total_tokens:5}};
  put('response.created',{type:'response.created',response:{...response,status:'in_progress'}});
  const message={id:'msg_'+requests.length,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'SYNTHETIC_READY',annotations:[]}]};
  put('response.output_item.added',{type:'response.output_item.added',output_index:0,item:message});
  put('response.output_text.delta',{type:'response.output_text.delta',item_id:message.id,output_index:0,content_index:0,delta:'SYNTHETIC_READY'});
  put('response.output_item.done',{type:'response.output_item.done',output_index:0,item:message});
  put('response.completed',{type:'response.completed',response:{...response,output:[message]}});
  res.end('data: [DONE]\\n\\n');
 });
});
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=server.address().port;
 const codex=new Codex({baseUrl:'http://127.0.0.1:'+port+'/v1',apiKey:'synthetic-only',
  env:{PATH:process.env.PATH||'',HOME:home,CODEX_HOME:state,CODEX_SQLITE_HOME:state,CODEX_API_KEY:'synthetic-only'}});
 const thread=codex.startThread({workingDirectory:repo,skipGitRepoCheck:false,sandboxMode:'workspace-write'});
 let completed=false;let diagnostics=[];
 try{
  const {events}=await thread.runStreamed('Reply SYNTHETIC_READY. No other work.');
  for await(const event of events){
   diagnostics.push(event.type);
   if(event.type==='turn.completed')completed=true;
  }
 }catch(error){diagnostics.push(String(error?.message||error).slice(0,400));}
 assert(requests.length>=1,'synthetic gateway never received SDK traffic');
 console.log(JSON.stringify({gatewayRequests:requests.length,completed,events:diagnostics.slice(-15),remaining,session:thread.id??null}));
 if(!completed)throw Error('SYNTHETIC_RESPONSES_PROTOCOL_NOT_QUALIFIED');
}finally{await new Promise(resolve=>server.close(resolve));rmSync(root,{recursive:true,force:true});}
