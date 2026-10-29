import {readFileSync,realpathSync} from 'node:fs';
import {posix} from 'node:path';
// One SDK execution path for Native, Thin and Full. The trusted host owns
// isolation, authorization and the metered Responses gateway.
export const BENCHMARK_ARMS=Object.freeze(['native','thin','full']);
export const NATIVE_PHASES=Object.freeze(['implementation','review','repair','final-review']);
export function assertNativeArmPhase(arm,phase){
 if(!BENCHMARK_ARMS.includes(arm))throw Error('NATIVE_ARM_INVALID');
 if(!NATIVE_PHASES.includes(phase))throw Error('NATIVE_PHASE_INVALID');
}
export async function executeSharedNativePhase({Codex,arm,phase,gateway,bearer,model,
 home,state,root,prompt,onEvent=()=>{},sandboxMode}){
 assertNativeArmPhase(arm,phase);
 if(typeof Codex!=='function'||!bearer||!model||!gateway||!root||!home||!state||
    typeof prompt!=='string'||!prompt.trim())throw Error('SHARED_NATIVE_SESSION_INVALID');
 const reviewing=phase==='review'||phase==='final-review';
 const mode=sandboxMode??(reviewing?'read-only':'danger-full-access');
 if(reviewing&&mode!=='read-only')throw Error('NATIVE_REVIEW_MUST_BE_READ_ONLY');
 // The outer namespace already enforces review immutability. A second SDK
 // namespace cannot be created inside it; verify the kernel boundary first.
 const sdkMode=reviewing&&process.env.KATIE_OUTER_SANDBOX_CONFIRMED==='1'
  ?attestedReviewSdkMode({rootRealPath:realpathSync(root),cwdRealPath:realpathSync(process.cwd()),mountInfo:readFileSync('/proc/self/mountinfo','utf8')})
  :mode;
 const codex=new Codex({baseUrl:gateway,apiKey:bearer,env:{
  PATH:process.env.PATH||'',HOME:home,CODEX_HOME:state,CODEX_SQLITE_HOME:state,
  CODEX_API_KEY:bearer}});
 const thread=codex.startThread({workingDirectory:root,skipGitRepoCheck:false,sandboxMode:sdkMode,model});
 const {events}=await thread.runStreamed(prompt);
 let completed=false,message='';
 for await(const event of events){
  await onEvent(event);
  if(event.type==='item.completed'&&event.item?.type==='agent_message'&&typeof event.item.text==='string')message=event.item.text;
  if(event.type==='turn.failed')throw Error('NATIVE_TURN_FAILED: '+nativeTurnFailureDetail(event.error,bearer));
  if(event.type==='turn.completed')completed=true;
 }
 if(!completed)throw Error('NATIVE_TURN_INCOMPLETE');
 return {completed,reviewMessage:message,threadId:thread.id??null,arm,phase};
}

// Retain SDK diagnostics without printing the gateway bearer or auth fields.
export function nativeTurnFailureDetail(error,bearer){
 let detail=typeof error?.message==='string'?error.message:typeof error?.code==='string'?error.code:'unknown SDK failure';
 if(typeof bearer==='string'&&bearer)detail=detail.split(bearer).join('[REDACTED]');
 return detail.replace(/Bearer\s+[^\s"',;]+/gi,'Bearer [REDACTED]')
  .replace(/sk-[A-Za-z0-9_-]+/g,'[REDACTED]')
  .replace(/((?:api[_-]?key|authorization|access[_-]?token)\s*[=:]\s*)[^\s,;]+/gi,'$1[REDACTED]')
  .replace(/[\x00-\x1f\x7f]/g,' ').slice(0,1200);
}

export function attestedReviewSdkMode({rootRealPath,cwdRealPath,mountInfo}){
 const fail=()=>{throw Error('NATIVE_REVIEW_OUTER_BOUNDARY_MISSING');};
 if(rootRealPath!=='/work'||cwdRealPath!=='/work'||typeof mountInfo!=='string')fail();
 let found=false;
 for(const line of mountInfo.split(/\r?\n/).filter(Boolean)){
  const fields=line.split(' ');if(fields.length<7||fields.indexOf('-')<6)fail();
  const mount=fields[4].replace(/\\([0-7]{3})/g,(_,octal)=>String.fromCharCode(parseInt(octal,8)));
  if(!mount.startsWith('/'))fail();
  const relative=posix.relative('/work',mount);
  if(relative==='')found=true;
  if(relative===''||(!relative.startsWith('../')&&relative!=='..'&&!posix.isAbsolute(relative))){
   const options=fields[5].split(',');if(!options.includes('ro')||options.includes('rw'))fail();
  }
 }
 if(!found)fail();
 return 'danger-full-access'; // SDK-only; the verified outer mounts stay read-only.
}
