// Common Native/Thin/Full execution boundary. No benchmark arm-specific policy.
// The trusted checkout's Git metadata and installed dependencies are always
// mounted read-only over the agent-writable repository during native execution.
import {lstatSync,realpathSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';

export function assertTrustedBoundary(workspace,dependencyRoot=join(workspace,'node_modules')){
 const root=realpathSync(workspace);
 const gitPath=join(root,'.git'),deps=resolve(dependencyRoot);
 for(const [name,path] of [['git',gitPath],['dependencies',deps]]){
  const st=lstatSync(path);
  if(st.isSymbolicLink())throw Error('NATIVE_UNTRUSTED_'+name.toUpperCase()+'_SYMLINK');
  const canonical=realpathSync(path);
  if(canonical!==path||!canonical.startsWith(root+sep))
   throw Error('NATIVE_UNTRUSTED_'+name.toUpperCase()+'_PATH');
  if(!st.isDirectory())throw Error('NATIVE_UNTRUSTED_'+name.toUpperCase()+'_TYPE');
 }
 return Object.freeze({root,gitPath,deps});
}

// Must be appended AFTER the candidate workspace binding: later bubblewrap
// mounts shadow the writable parent bind, and cannot be remounted from inside.
export function protectedNativeMounts(boundary){
 if(!boundary?.gitPath||!boundary?.deps)throw Error('NATIVE_BOUNDARY_REQUIRED');
 return ['--ro-bind',boundary.gitPath,'/work/.git',
         '--ro-bind',boundary.deps,'/work/node_modules'];
}

// Every trusted host Git operation disables checkout-provided hooks, external
// helpers and unsafe diff filters. Git config is NEVER sourced from the
// native process environment, and input args are separate execFile arguments.
export const protectedGitConfig=[
 '-c','core.hooksPath=/dev/null',
 '-c','core.fsmonitor=false',
 '-c','core.pager=cat',
 '-c','diff.external=',
 '-c','protocol.ext.allow=never'
];
