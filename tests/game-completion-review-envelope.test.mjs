import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
const source=readFileSync('lib/missions/request-budget.ts','utf8');
const code=source.slice(source.indexOf('export function missionInputLimit'),source.indexOf('/** A rejected reservation'));
const {missionInputLimit,missionOutputLimit,fitsMissionEnvelope}=vm.runInNewContext(stripTypeScriptTypes(code.replace(/export /g,''))+';({missionInputLimit,missionOutputLimit,fitsMissionEnvelope})',{readOnlyRepositoryObjective:()=>false,measureDeliverable:()=>({wordLimit:null})});
for(const [phase,evidence] of [['development',{gameContract:{}}],['assessment',{gameRules:{}}]])test('complete '+phase+' game candidate fits independent review without raising compose output',()=>{
 const claim={mission:{project_kind:phase,objective:'Complete approved game',project_evidence:evidence},job:{role:'review',payload:{}}};
 assert.equal(missionInputLimit(claim),96000);assert.equal(fitsMissionEnvelope('instruction','x'.repeat(85674),missionInputLimit(claim)),true);assert.equal(fitsMissionEnvelope('instruction','x'.repeat(96001),missionInputLimit(claim)),false);
 claim.job.role='compose';assert.equal(missionInputLimit(claim),48000);assert.equal(missionOutputLimit(claim,'complete outcome'),6000);
 claim.job.role='review';claim.mission.project_evidence={};assert.equal(missionInputLimit(claim),48000);
});
