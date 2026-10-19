import {readFileSync,lstatSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {assertPaths} from './control.mjs';
const [planFile,round]=process.argv.slice(2);
const plan=JSON.parse(readFileSync(planFile,'utf8'));
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
git('merge-base','--is-ancestor',plan.config.baselineSha,'HEAD');
const existing=git('diff','--name-only',plan.config.baselineSha,'HEAD','--').split('\n').filter(Boolean);
if(existing.length)assertPaths(existing,plan.config);
const modified=git('diff','--name-only','HEAD','--').split('\n').filter(Boolean);
const untracked=git('ls-files','--others','--exclude-standard').split('\n').filter(Boolean);
const changes=[...new Set([...modified,...untracked])];
// Evidence-only findings may require re-verification without changing a correct game.
// The independent exact-head tests and reviewer still decide whether it passes.
if(!changes.length){console.log(git('rev-parse','HEAD'));process.exit(0);}
assertPaths(changes,plan.config);
for(const path of plan.config.allowedPaths){const stat=lstatSync(resolve(path));if(!stat.isFile()||stat.isSymbolicLink())throw Error('Only regular source files are allowed');}
git('add','--',...plan.config.allowedPaths);
git('config','user.name','github-actions[bot]');git('config','user.email','41898282+github-actions[bot]@users.noreply.github.com');
git('commit','-m',`game-repair: ${plan.game} PR #${plan.pr} round ${round}`);
console.log(git('rev-parse','HEAD'));
