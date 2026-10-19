import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Trusted owner-created recovery markers bind a repair to an immutable
// starting commit and explicit paths. Models may suggest changes but cannot
// widen this code-enforced scope by rewriting the issue or tests.
export function parseRecoveryScope(request){
 if(typeof request!=='string'||Buffer.byteLength(request)>100_000)throw Error('Recovery issue exceeds input bounds');
 const occurrences=request.match(/<!--\s*katie-recovery\b/g)||[];
 if(!occurrences.length)return null;
 const markers=[...request.matchAll(/<!-- katie-recovery: ([A-Za-z0-9_-]+) -->/g)];
 if(occurrences.length!==1||markers.length!==1||markers[0][1].length>12000)throw Error('Invalid or duplicate recovery marker');
 const raw=Buffer.from(markers[0][1],'base64url');
 if(raw.length>8192||raw.toString('base64url')!==markers[0][1])throw Error('Recovery marker is malformed');
 const meta=JSON.parse(raw.toString('utf8'));
 if(!meta||typeof meta!=='object'||Array.isArray(meta)||
  Object.keys(meta).sort().join()!==['version','caseId','sourceSha','allowedPaths','category'].sort().join()||
  meta.version!==1)throw Error('Invalid recovery metadata');
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(meta.caseId)||
   !/^[a-f0-9]{40}$/.test(meta.sourceSha)||
   !['verification_infrastructure','implementation'].includes(meta.category)||
   !Array.isArray(meta.allowedPaths)||!meta.allowedPaths.length||meta.allowedPaths.length>12)throw Error('Recovery identity or paths missing');
 for(const path of meta.allowedPaths){
  if(typeof path!=='string'||path.length<3||path.length>200||
   !/^(?:app|apps|components|lib|scripts|tests|packages)\/[a-zA-Z0-9_./[\]-]+\/?$/.test(path)||
   path.split('/').filter((p,i,parts)=>!(i===parts.length-1&&p==='')).some(p=>!p||p==='.'||p==='..'||p==='node_modules'||p.startsWith('.env')) ||
   (path.endsWith('/')&&path.split('/').filter(Boolean).length<2)||
   /(^|\/)(?:package(?:-lock)?\.json|vercel\.json|next\.config\.[a-z]+|\.npmrc|.*\.ya?ml)$/.test(path))throw Error('Recovery path escaped approved scope');
 }
 return meta;
}
export function assertRecoveryScope(request,workspace=process.cwd()){
 const c=parseRecoveryScope(readFileSync(request,'utf8'));if(!c)return null;
 const git=args=>execFileSync('git',['-c','core.fsmonitor=false',...args],{cwd:workspace,encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
 git(['merge-base','--is-ancestor',c.sourceSha,'HEAD']);
 const changed=git(['diff','--cached','--no-ext-diff','--no-renames','--name-only','-z',c.sourceSha,'--']).split('\0').filter(Boolean);
 if(!changed.length)throw Error('Recovery agent produced no scoped fix');
 for(const path of changed){
  if(!c.allowedPaths.some(p=>path===p||p.endsWith('/')&&path.startsWith(p)))throw Error('Recovery agent modified unapproved path '+path);
  const mode=git(['ls-files','--stage','--',path]).split(' ')[0];
  if(mode==='120000'||mode==='160000')throw Error('Recovery symlinks and submodules are forbidden');
 }
 return changed;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  if(process.argv[2]==='prepare'&&process.argv.length===4)console.log(JSON.stringify(parseRecoveryScope(readFileSync(process.argv[3],'utf8'))));
  else if(process.argv.length===3)assertRecoveryScope(process.argv[2]);
  else throw Error('Usage: recovery-scope.mjs [prepare] ORIGINAL_OWNER_ISSUE');
 }catch(e){console.error(String(e.message).slice(0,700));process.exitCode=1;}
}
