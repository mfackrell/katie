import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
export const NATIVE_EXECUTION_EVIDENCE_VERSION='bounded-execution-v1';
const hash=value=>createHash('sha256').update(String(value??'')).digest('hex');
export function sanitizeEvidence(value,secrets=[]){
 let text=String(value??'');
 for(const secret of secrets.filter(Boolean))text=text.split(secret).join('[REDACTED]');
 return text.replace(/<!--\s*katie-[\s\S]*?-->/g,'[REDACTED HANDOFF]')
  .replace(/Bearer\s+[^\s"',;]+/gi,'Bearer [REDACTED]')
  .replace(/(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/g,'[REDACTED]')
  .replace(/((?:api[_-]?key|authorization|access[_-]?token|password|secret)[\"']?\s*[=:]\s*[\"']?)[^\s,;]+/gi,'$1[REDACTED]')
  .replace(/[A-Za-z0-9_+/=-]{64,}(?:\.[A-Za-z0-9_+/=-]+)*/g,'[REDACTED ENCODED DATA]')
  .replace(/[\x00-\x1f\x7f]/g,' ').slice(0,1600);
}
export function summarizeNativeEvent(event,secrets=[]){
 if(!['item.started','item.completed','turn.completed','turn.failed','error'].includes(event?.type))return null;
 const item=event.item,base={event:event.type};
 if(item){
  if(!['command_execution','file_change','agent_message','mcp_tool_call'].includes(item.type))return null;
  base.itemType=item.type;base.itemId=hash(item.id).slice(0,16);
  base.status=['in_progress','completed','failed'].includes(item.status)?item.status:null;
  if(item.type==='command_execution'){
   base.commandHash=hash(item.command);base.exitCode=Number.isInteger(item.exit_code)?item.exit_code:null;
   // Never retain command arguments or command output: reads can contain protected data.
   base.outputBytes=Buffer.byteLength(String(item.aggregated_output??''));
   base.errors=['Permission denied','Read-only file system','No such file or directory','command not found','not a git repository'].filter(x=>String(item.aggregated_output??'').includes(x));
  }
  if(item.type==='file_change')base.changes=(item.changes??[]).slice(0,20).map(x=>({path:sanitizeEvidence(x.path,secrets).slice(0,200),kind:['add','delete','update'].includes(x.kind)?x.kind:'unknown'}));
  if(item.type==='agent_message')base.message=sanitizeEvidence(item.text,secrets);
  if(item.type==='mcp_tool_call')base.toolHash=hash(item.tool);
 }
 if(event.type==='turn.failed'||event.type==='error')base.error=sanitizeEvidence(event.error?.message??event.message,secrets);
 return base;
}
export function worktreeEvidence(root,secrets=[]){
 const git=(...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:root,encoding:'utf8',timeout:10000,maxBuffer:256*1024});
 try{return {head:git('rev-parse','HEAD').trim(),status:git('status','--porcelain=v1','-z','--untracked-files=all').split('\0').filter(Boolean).slice(0,100).map(x=>sanitizeEvidence(x,secrets).slice(0,200))};}
 catch{return {unavailable:true};}
}
