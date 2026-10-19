import {readFileSync,lstatSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {assertPaths} from './control.mjs';
const plan=JSON.parse(readFileSync(process.argv[2],'utf8'));
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
git('merge-base','--is-ancestor',plan.config.baselineSha,'HEAD');
const changed=git('diff','--name-only',plan.config.baselineSha,'HEAD','--').split('\n').filter(Boolean);
if(changed.length)assertPaths(changed,plan.config);
if(git('status','--porcelain'))throw Error('Candidate checkout must start clean');

for(const path of plan.config.allowedPaths){const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Only regular registered game files are allowed');}
