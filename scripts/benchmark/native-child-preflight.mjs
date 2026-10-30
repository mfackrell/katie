import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {sharedNativeContainerArgs} from './shared-native-container.mjs';
import {protectedNativeMounts} from './native-trust-boundary.mjs';

// Import the actual pinned SDK in the actual child namespace before any grant.
// No gateway, bearer, database credential or upstream credential exists here.
export function preflightNativeChild(boundary,childFile){
 const socketDir=mkdtempSync(join(tmpdir(),'native-child-preflight-'));
 try{
  const trusted=dirname(childFile);
  const command='socat TCP-LISTEN:43181,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/gateway/absent.sock & p=$!; trap "kill $p 2>/dev/null || :" EXIT; node /trusted/native-development-child.mjs --preflight';
  const args=sharedNativeContainerArgs({workspace:boundary.root,socketDir,arm:'full',phase:'implementation',command,
   extraMounts:[...protectedNativeMounts(boundary),'--dir','/trusted',
    '--ro-bind',childFile,'/trusted/native-development-child.mjs',
    '--ro-bind',join(trusted,'native-execution-evidence.mjs'),'/trusted/native-execution-evidence.mjs',
    '--ro-bind',join(trusted,'shared-native-phase.mjs'),'/trusted/shared-native-phase.mjs',
    '--ro-bind',join(trusted,'shared-native-policy.mjs'),'/trusted/shared-native-policy.mjs']});
  const output=execFileSync('bwrap',args,{env:{PATH:process.env.PATH||''},encoding:'utf8',timeout:20000});
  if(!output.split('\n').includes('NATIVE_CHILD_PREFLIGHT_OK'))throw Error('NATIVE_CHILD_PREFLIGHT_FAILED');
 }finally{rmSync(socketDir,{recursive:true,force:true});}
}

