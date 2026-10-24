// Real Codex SDK containment probe. No production credentials or paid inference.
// A local deny-only upstream proves that an attempted request cannot reach a provider.
// Does NOT establish editor/terminal functionality, restart, or gateway spending controls.
import {Codex} from '@openai/codex-sdk';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const root=mkdtempSync(join(tmpdir(),'codex-deny-'));
const home=join(root,'home'),codexHome=join(home,'.codex'),repo=join(root,'repo');
mkdirSync(codexHome,{recursive:true});mkdirSync(repo);
execFileSync('git',['init','-q',repo],{env:{PATH:process.env.PATH}});
let requests=0;
const server=createServer((req,res)=>{
 requests++;
 const chunks=[];req.on('data',c=>chunks.push(c));
 req.on('end',()=>{res.writeHead(403,{'content-type':'application/json'});
 res.end(JSON.stringify({error:{message:'NONBILLABLE_GATEWAY_DENIED',type:'insufficient_quota',code:'insufficient_quota'}}));});
});
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();
 assert(address&&typeof address==='object');
 const sdk=new Codex({
  baseUrl:'http://127.0.0.1:'+address.port+'/v1',
  apiKey:'synthetic-deny-only',
  env:{PATH:process.env.PATH||'',HOME:home,CODEX_HOME:codexHome,CODEX_SQLITE_HOME:codexHome,
       CODEX_API_KEY:'synthetic-deny-only'},
 });
 const thread=sdk.startThread({workingDirectory:repo,skipGitRepoCheck:false,sandboxMode:'read-only'});
 let ended=false;
 try{
  const streamed=await thread.runStreamed('Respond with READY. No file changes.');
  for await(const event of streamed.events)if(event.type==='turn.completed'||event.type==='turn.failed')ended=true;
 }catch(error){ended=true;process.stdout.write('SDK_DENIAL='+String(error?.message??error).slice(0,180)+'\\n');}
 assert(ended,'SDK did not terminate on deny-only gateway');
 assert(requests>0,'No attempt reached local gateway: SDK transport unqualified');
 process.stdout.write(JSON.stringify({result:'DENY_ONLY_INTERCEPTED',requests,realSdk:true,
  toolsTested:false,recoveryTested:false,providerBypassTested:false})+'\\n');
}finally{
 await new Promise(resolve=>server.close(resolve));
 rmSync(root,{recursive:true,force:true});
}
