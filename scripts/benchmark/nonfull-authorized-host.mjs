// Trusted Native/Thin execution host. Never run against production databases:
// this qualification requires a disposable PostgreSQL-backed adapter and a
// scripted upstream. It issues the ACTUAL canonical DB grant before SDK calls.
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {createNonFullTrustedGateway} from './nonfull-trusted-gateway.mjs';
import {sharedNativeContainerArgs} from './shared-native-container.mjs';
import {assertTrustedBoundary,protectedNativeMounts} from './native-trust-boundary.mjs';
export async function runNonFullAuthorizedHost({
 db,arm,trial,account,approval,ownerId,repository,workspace,
 upstream,model='synthetic',upperTokens=20,onEvent=()=>{}
}){
 if(!['native','thin'].includes(arm)||!db||!workspace||
  process.env.KATIE_BENCHMARK_PAID_EXECUTION==='enabled')
  throw Error('NONFULL_HOST_PAID_EXECUTION_DENIED');
 const boundary=assertTrustedBoundary(workspace);
 const secret='contained-fixture-token';
 const {server,grantId,trialId}=await createNonFullTrustedGateway({
  db,arm,trial,account,approval,ownerId,repository,upstream,
  clientToken:secret,upperTokens
 });
 const root=mkdtempSync(join(tmpdir(),'nonfull-trusted-host-'));
 const dir=join(root,'socket'),sock=join(dir,'gateway.sock');mkdirSync(dir,{mode:0o700});
 const results=[];
 try{
  await new Promise(resolve=>server.listen(sock,resolve));
  for(const phase of ['implementation','review','repair','final-review']){
   const reviewing=phase==='review'||phase==='final-review';
   const command='socat TCP-LISTEN:43181,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/gateway/gateway.sock & proxy=$!; trap "kill $proxy 2>/dev/null || :" EXIT; node /app/scripts/benchmark/native-four-phase-contained-client.mjs';
   const args=sharedNativeContainerArgs({
    workspace:boundary.root,socketDir:dir,arm,phase,command,readOnly:reviewing,
    extraMounts:[...protectedNativeMounts(boundary),
     '--ro-bind',process.cwd(),'/app'],
    extraEnv:['--setenv','KATIE_NATIVE_MODEL',model]
   });
   const child=spawn('bwrap',args,{env:{PATH:process.env.PATH||''},stdio:['ignore','pipe','pipe']});
   let output='',error='';
   child.stdout.on('data',x=>output+=x);
   child.stderr.on('data',x=>error+=x);
   const code=await new Promise((resolve,reject)=>{
    child.once('error',reject);child.once('close',resolve);
   });
   results.push({phase,code});
   onEvent({phase,code});
   if(code!==0)throw Error('NONFULL_HOST_PHASE_FAILED:'+phase+':'+error.slice(-1600));
  }
  return {arm,trialId,grantId,phases:results,accepted:false,
   receiptStatus:'REQUIRES_INDEPENDENT_DATABASE_RECONCILIATION'};
 }finally{
  await new Promise(resolve=>server.close(resolve));
  rmSync(root,{recursive:true,force:true});
 }
}
