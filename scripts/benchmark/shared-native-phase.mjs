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
 const codex=new Codex({baseUrl:gateway,apiKey:bearer,env:{
  PATH:process.env.PATH||'',HOME:home,CODEX_HOME:state,CODEX_SQLITE_HOME:state,
  CODEX_API_KEY:bearer}});
 const thread=codex.startThread({workingDirectory:root,skipGitRepoCheck:false,sandboxMode:mode,model});
 const {events}=await thread.runStreamed(prompt);
 let completed=false,message='';
 for await(const event of events){
  await onEvent(event);
  if(event.type==='item.completed'&&event.item?.type==='agent_message'&&typeof event.item.text==='string')message=event.item.text;
  if(event.type==='turn.failed')throw Error('NATIVE_TURN_FAILED');
  if(event.type==='turn.completed')completed=true;
 }
 if(!completed)throw Error('NATIVE_TURN_INCOMPLETE');
 return {completed,reviewMessage:message,threadId:thread.id??null,arm,phase};
}
