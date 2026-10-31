// Trusted host only. WIP tags preserve source, never execution authority or a
// reviewed candidate. No checkout, real-index mutation, grant or ledger writes.
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync,openSync,closeSync,fstatSync,readSync,constants} from 'node:fs';
import {join} from 'node:path';
import {protectedGitConfig} from './native-trust-boundary.mjs';
import {sanitizeEvidence} from './native-execution-evidence.mjs';

// Linux native hosts: anchor each component to an already-open directory, so
// a concurrent rename/symlink swap cannot redirect a read outside the workspace.
function readSource(workspace,path){
 const descriptors=[];
 try{
  let fd=openSync(workspace,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);descriptors.push(fd);
  const parts=path.split('/');
  for(let i=0;i<parts.length;i++){
   fd=openSync(`/proc/self/fd/${fd}/${parts[i]}`,constants.O_RDONLY|constants.O_NOFOLLOW|
    (i<parts.length-1?constants.O_DIRECTORY:constants.O_NONBLOCK));descriptors.push(fd);
  }
  const st=fstatSync(fd);
  if(!st.isFile()||st.nlink!==1||st.size>4*1024*1024)throw Error('NATIVE_WIP_SOURCE_DENIED');
  const buffer=Buffer.alloc(4*1024*1024+1);let length=0,n;
  while(length<buffer.length&&(n=readSync(fd,buffer,length,buffer.length-length,null))>0)length+=n;
  if(length>4*1024*1024)throw Error('NATIVE_WIP_SOURCE_DENIED');
  return {content:buffer.subarray(0,length),mode:st.mode&0o111?'100755':'100644'};
 }catch(error){if(error.code==='ENOENT')return null;throw error;}
 finally{for(const fd of descriptors.reverse())closeSync(fd);}
}

export function createNativeWipCheckpointer({workspace,tempRoot,toolsRoot,requestFile,
 context,identity,secrets=[],expectedHead}){
 const deny=()=>{throw Error('NATIVE_WIP_CHECKPOINT_DENIED');};
 if(!context?.allowedPaths?.length||context.projectId!==identity.projectId||
    !/^[a-f0-9-]{36}$/.test(identity.taskId)||
    !/^[0-9]+$/.test(identity.runId)||! /^[0-9]+$/.test(identity.runAttempt))deny();
 let sequence=0,last=null;
 const git=(args,env,input)=>execFileSync('git',[...protectedGitConfig,...args],{
  cwd:workspace,env, input,encoding:'utf8',timeout:20000,maxBuffer:8*1024*1024,stdio:['pipe','pipe','pipe']}).trim();
 const baseEnv={...process.env};
 // The trusted host, not a caller-supplied Git index, owns each snapshot.
 delete baseEnv.GIT_INDEX_FILE;
 return {save({phase,reviewFindings='',lastCompleted={}}){
  if(!['implementation','repair'].includes(phase))return null;
  const scratch=mkdtempSync(join(tempRoot,'wip-'));
  const env={...baseEnv,GIT_INDEX_FILE:join(scratch,'index')};
  try{
   const head=git(['rev-parse','HEAD'],env);
   if(head!==expectedHead())deny();
   git(['read-tree',head],env);
   const paths=[...new Set(git(['ls-files','--modified','--deleted','--others','--exclude-standard','-z'],env).split('\0').filter(Boolean))];
   if(paths.length>200)deny();
   let bytes=0;
   for(const path of paths){
    if(path==='AGENT_REQUEST.md'&&!git(['ls-files','--',path],env))continue;
    if(path.startsWith('/')||path.split('/').some(p=>!p||p==='.'||p==='..')||
       !context.allowedPaths.some(p=>path===p||p.endsWith('/')&&path.startsWith(p)))deny();
    const source=readSource(workspace,path);
    if(!source){git(['update-index','--force-remove','--',path],env);continue;}
    const {content,mode}=source;bytes+=content.length;
    if(bytes>4*1024*1024||secrets.filter(s=>typeof s==='string'&&s.length>=8).some(s=>content.includes(Buffer.from(s))))deny();
    // Do not run repository-configured clean filters in the credentialed host.
    const blob=git(['hash-object','-w','--no-filters','--stdin'],env,content);
    git(['update-index','--add','--cacheinfo',mode,blob,path],env);
   }
   const tree=git(['write-tree'],env);
   if(tree===git(['rev-parse',head+'^{tree}'],env))return null;
   // Validate the frozen cumulative scope using the unchanged trusted gates.
   for(const tool of ['project-scope.mjs','recovery-scope.mjs'])execFileSync(process.execPath,[join(toolsRoot,tool),requestFile],{
    cwd:workspace,env,timeout:20000,stdio:'pipe'});
   const metadata={version:1,kind:'native-unverified-wip',verification:'unverified',
    ...identity,originalBaselineSha:context.baselineSha,baseSha:context.baseSha,
    approvedScope:{hash:identity.approvedScopeHash,allowedPaths:context.allowedPaths,contractHash:context.contractHash},
    phase,sourceTreeSha:tree,completedCheckpointSha:head,
    reviewFindings:sanitizeEvidence(reviewFindings,secrets,12000),lastCompleted,
    savedAt:new Date().toISOString()};
   const message=JSON.stringify(metadata);
   if(Buffer.byteLength(message)>24000)deny();
   if(last?.tree===tree&&last.phase===phase&&last.message===JSON.stringify({...metadata,savedAt:last.savedAt}))return last.record;
   const sha=git(['-c','user.name=katie-unverified-wip','-c','user.email=katie-native-checkpoint@users.noreply.github.com',
    'commit-tree',tree,'-p',head,...(last?['-p',last.record.checkpointSha]:[])],env,message+'\n');
   const ref=`refs/tags/katie-wip/${identity.taskId}/${identity.runId}-${identity.runAttempt}/${++sequence}`;
   // Immutable refs. A lost push response is success only if remote readback
   // confirms the exact object. A collision is never overwritten.
   try{git(['push','--force-with-lease='+ref+':','origin',sha+':'+ref],env);}catch{/* read back below */}
   if(git(['ls-remote','--refs','origin',ref],env).split(/\s/)[0]!==sha)deny();
   const record={checkpointSha:sha,ref,...metadata};
   last={tree,phase,message,savedAt:metadata.savedAt,record};
   return record;
  }finally{rmSync(scratch,{recursive:true,force:true});}
 }};
}
