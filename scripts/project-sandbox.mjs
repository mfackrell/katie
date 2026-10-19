import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
// Minimal mount/PID/user namespace. No host home, runner temp, Docker socket,
// parent /proc or trusted contracts are visible to generated application code.
export function sandboxArgs(workspace,{dependencies,network=false,writable=false}={}){
 const root=resolve(workspace),args=['--die-with-parent','--new-session','--unshare-user','--unshare-pid','--unshare-ipc','--cap-drop','ALL','--clearenv'];
 // bubblewrap calls loopback_setup() for --unshare-net, including IFF_UP.
 // See containers/bubblewrap bubblewrap.c; the boundary integration test
 // makes a real HTTP round trip here rather than assuming loopback works.
 if(!network)args.push('--unshare-net');
 for(const p of ['/usr','/bin','/sbin','/lib','/lib64','/opt','/etc'])if(existsSync(p))args.push('--ro-bind',p,p);
 args.push('--proc','/proc','--dev','/dev','--tmpfs','/tmp',writable?'--bind':'--ro-bind',root,'/app');
 if(existsSync(resolve(root,'.git')))args.push('--ro-bind',resolve(root,'.git'),'/app/.git');
 if(dependencies){
  // Keep ALL baseline modules read-only, but give Vite/Vitest an ephemeral
  // per-run cache. The cache cannot mutate the dependency tree, and is lost
  // when the browser/test subprocess exits.
  args.push('--ro-bind',resolve(dependencies),'/app/node_modules',
    '--tmpfs','/app/node_modules/.vite');
 }
 args.push('--chdir','/app','--setenv','PATH',process.env.PATH??'/usr/bin:/bin','--setenv','HOME','/tmp','--setenv','TMPDIR','/tmp','--setenv','LANG','C.UTF-8','--setenv','GIT_OPTIONAL_LOCKS','0','--remount-ro','/');
 return args;
}
