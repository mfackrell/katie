// The exact Bubblewrap security profile for every benchmark arm.
// Trusted host builds arguments; the model never receives host credentials.
import {assertNativeArmPhase} from './shared-native-phase.mjs';
export function sharedNativeContainerArgs({workspace,socketDir,arm,phase,
 command,extraMounts=[],extraEnv=[],readOnly=false}){
 assertNativeArmPhase(arm,phase);
 if(typeof workspace!=='string'||!workspace.startsWith('/')||
    typeof socketDir!=='string'||!socketDir.startsWith('/')||
    typeof command!=='string'||!command.startsWith('socat TCP-LISTEN:43181,')||
    !Array.isArray(extraMounts)||!Array.isArray(extraEnv))
  throw Error('SHARED_NATIVE_CONTAINER_INVALID');
 const reviewing=phase==='review'||phase==='final-review';
 if(readOnly!==reviewing)throw Error('SHARED_NATIVE_PHASE_MOUNT_MISMATCH');
 return [
  '--die-with-parent','--new-session','--unshare-all','--clearenv',
  '--ro-bind','/usr','/usr','--ro-bind','/bin','/bin',
  '--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64',
  '--ro-bind','/opt','/opt',
  reviewing?'--ro-bind':'--bind',workspace,'/work',
  ...extraMounts,
  '--bind',socketDir,'/gateway','--tmpfs','/tmp','--proc','/proc','--dev','/dev',
  '--setenv','HOME','/tmp/agent',
  '--setenv','CODEX_HOME','/tmp/agent/.codex',
  '--setenv','PATH',process.env.PATH||'/usr/bin:/bin',
  '--setenv','KATIE_BENCHMARK_ARM',arm,
  '--setenv','KATIE_NATIVE_PHASE',phase,
  '--setenv','KATIE_OUTER_SANDBOX_CONFIRMED','1',
  ...extraEnv,
  '--chdir','/work','/bin/sh','-c',command
 ];
}
