import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
// Minimal mount/PID/user namespace. No host home, runner temp, Docker socket,
// parent /proc or trusted contracts are visible to generated application code.
export function sandboxArgs(workspace,{dependencies,network=false,writable=false}={}){
 const root=resolve(workspace),args=['--die-with-parent','--new-session','--unshare-user','--unshare-pid','--unshare-ipc','--cap-drop','ALL','--clearenv'];
 if(!network)args.push('--unshare-net');
 for(const p of ['/usr','/bin','/sbin','/lib','/lib64','/opt','/etc'])if(existsSync(p))args.push('--ro-bind',p,p);
 args.push('--proc','/proc','--dev','/dev','--tmpfs','/tmp',writable?'--bind':'--ro-bind',root,'/app');
 if(existsSync(resolve(root,'.git')))args.push('--ro-bind',resolve(root,'.git'),'/app/.git');
 if(dependencies)args.push('--ro-bind',resolve(dependencies),'/app/node_modules');
 args.push('--chdir','/app','--setenv','PATH',process.env.PATH??'/usr/bin:/bin','--setenv','HOME','/tmp','--setenv','TMPDIR','/tmp','--setenv','LANG','C.UTF-8','--setenv','GIT_OPTIONAL_LOCKS','0','--remount-ro','/');
 return args;
}
