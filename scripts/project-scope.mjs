import {execFileSync} from 'node:child_process';import {readFileSync} from 'node:fs';import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {parseProjectContext} from './project-context.mjs';
// Preserved main tool, executed only after staging, before every push. Inspect
// the entire staged tree against the original approved project baseline, so
// inherited, renamed, deleted and newly added paths cannot escape this scope.
export function assertProjectScope(request,workspace=process.cwd(),verifyCommitted=false){
 const c=parseProjectContext(readFileSync(request,'utf8'));if(!c)return;
 const git=args=>execFileSync('git',['-c','core.fsmonitor=false',...args],{cwd:workspace,encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
 git(['merge-base','--is-ancestor',c.baselineSha,'HEAD']);git(['merge-base','--is-ancestor',c.baseSha,'HEAD']);
 const changed=git(['diff',...(verifyCommitted?[]:['--cached']),'--no-ext-diff','--no-renames','--name-only','-z',c.baselineSha,...(verifyCommitted?['HEAD']:['--'])]).split('\0').filter(Boolean);
 if(!changed.length)throw Error('Project produced no cumulative change');
 for(const path of changed){if(path.split('/').some(p=>p==='.github'||p==='.git'||p==='node_modules'||p.startsWith('.env')||/^(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|\.npmrc|vercel\.json|next\.config\.[a-z]+)$/.test(p)))throw Error('Project publishing denied: protected configuration '+path);if(!c.allowedPaths.some(p=>path===p||p.endsWith('/')&&path.startsWith(p)))throw Error('Project publishing denied: unapproved path '+path);const mode=git(['ls-files','--stage','--',path]).split(' ')[0];if(mode==='120000'||mode==='160000')throw Error('Project publishing denied: symlinks and submodules are unavailable');}
 return changed;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{if(process.argv.length!==3&&!(process.argv.length===4&&process.argv[3]==='--verify-committed'))throw Error('Usage: project-scope.mjs PRESERVED_REQUEST [--verify-committed]');assertProjectScope(process.argv[2],process.cwd(),process.argv[3]==='--verify-committed');}catch(e){console.error(String(e.message).slice(0,700));process.exitCode=1;}}
