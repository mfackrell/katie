import {existsSync,lstatSync,readdirSync,realpathSync,openSync,closeSync,constants,fstatSync,readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
// Minimal mount/PID/user namespace. No host home, runner temp, Docker socket,
// parent /proc or trusted contracts are visible to generated application code.
export function sandboxArgs(workspace,{dependencies,network=false,writable=false,artifacts}={}){
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
 // Overlay only an absent or empty diagnostics directory. Never hide source,
 // tracked artifacts or a symlink from scope validation/checkpoint preservation.
 if(artifacts){
  const target=resolve(root,'test-artifacts'),external=realpathSync(artifacts),source=realpathSync(root);
  if(external===source||external.startsWith(source+'/')||source.startsWith(external+'/'))throw Error('Artifact mount must be outside candidate checkout');
  if(lstatSync(artifacts).isSymbolicLink()||!lstatSync(external).isDirectory())throw Error('Invalid artifact mount');
  try{const st=lstatSync(target);if(st.isSymbolicLink()||!st.isDirectory()||readdirSync(target).length)throw Error('Refusing to hide candidate artifacts');}catch(e){if(e.code!=='ENOENT')throw e;}
  args.push('--bind',external,'/app/test-artifacts');
 }
 args.push('--chdir','/app','--setenv','PATH',process.env.PATH??'/usr/bin:/bin','--setenv','HOME','/tmp','--setenv','TMPDIR','/tmp','--setenv','LANG','C.UTF-8','--setenv','GIT_OPTIONAL_LOCKS','0','--remount-ro','/');
 return args;
}

// Diagnostics are untrusted sandbox output. Never let the host artifact uploader
// follow candidate-created links into credentials outside the mount.
export function collectTestArtifacts(source,destination){
 const fds=[];
 try{
  let dir=openSync(source,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);fds.push(dir);
  try{dir=openSync(`/proc/self/fd/${dir}/standalone-rail`,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);fds.push(dir);}catch(e){if(e.code==='ENOENT')return;throw e;}
  const names=readdirSync(`/proc/self/fd/${dir}`);if(names.length>100)throw Error('Too many test artifacts');
  let total=0;
  for(const name of names){
   if(!/^[a-zA-Z0-9_.-]+\.png$/.test(name))throw Error('Invalid test artifact name');
   const fd=openSync(`/proc/self/fd/${dir}/${name}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
   try{
    const st=fstatSync(fd);if(!st.isFile()||st.nlink!==1||st.size>10*1024*1024)throw Error('Invalid test artifact file');
    total+=st.size;if(total>50*1024*1024)throw Error('Test artifact limit exceeded');
    const bytes=readFileSync(fd);if(bytes.length!==st.size)throw Error('Test artifact changed');
    mkdirSync(destination,{recursive:true});writeFileSync(resolve(destination,name),bytes,{flag:'wx'});
   }finally{closeSync(fd);}
  }
 }finally{for(const fd of fds.reverse())closeSync(fd);}
}
