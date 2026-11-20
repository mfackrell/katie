import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const config=JSON.parse(readFileSync(new URL('../vercel.json',import.meta.url),'utf8'));
const preservedDisabled=[
 'fix/owner-renewal-resume-controls-20261116',
 'fix/commissioning-diagnostics-1061',
 'codex/visual-review-integration',
 'fix/scoped-root-delegation-retry-20261114',
 'fix/management-loop-1048',
 'fix/paused-expired-window-renewal-1050',
 'fix/generated-image-perception-20261116',
 'fix/generated-image-recall-20261116'
];

test('Git main cannot automatically deploy or reassign original DO production alias',()=>{
 assert.deepEqual(config.git.deploymentEnabled.main,false,
  'main production releases must use the guarded operator, not a Git push');
 assert.deepEqual(config.git.deploymentEnabled['*'],undefined,
  'Other feature branches retain Vercel default preview deployment behavior');
 for(const [branch,enabled] of Object.entries(config.git.deploymentEnabled)){
  assert.equal(enabled,false,'No wildcard true override or reenabled branch: '+branch);
 }
});

test('feature branch previews, existing opt-outs, production cron and chat settings are preserved',()=>{
 const rules=config.git.deploymentEnabled;
 for(const branch of preservedDisabled)assert.equal(rules[branch],false,branch);
 assert.equal(rules['fix/protected-release-example'],undefined,
  'Ordinary feature PRs continue generating preview deployments');
 assert.equal(config.functions['app/api/chat/route.ts'].maxDuration,800);
 assert.equal(config.crons.length,9,'Existing application cron schedule must not be dropped');
 assert.ok(config.crons.some(x=>x.path==='/api/internal/missions/run'
  &&x.schedule==='* * * * *'),'Existing orchestrator cron must remain');
 assert.ok(!('github' in config&&config.github?.enabled===false),
  'Do not globally disconnect GitHub or disable preview branch development');
});
