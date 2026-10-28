import {createHash} from 'node:crypto';
import {validateProjectPlan,canonical} from './contract';
import {parseJSON} from '@/lib/missions/types';
import {applyMissionRevisionPatch} from '@/lib/missions/revision-patch';

// A serialization format, not a new acceptance contract. Registered browser
// scenarios are expanded verbatim; the unchanged complete-plan validator runs last.
export const COMPACT_GAME_FORMAT='registered-game-v1';
export const COMPACT_GAME_INSTRUCTION=`COMPACT SERIALIZATION (supersedes instructions to repeat browser contracts): Add specificationFormat:"registered-game-v1". Return exactly one milestone {title,instruction}, no contract field. Return finalContract:{path} only. Put every complete model/browser scenario once in game.acceptance.scenarios. The server copies browser scenarios in order to finalContract.scenarios as {name:id,steps} and copies that contract to the milestone. All original rules, coverage, state assertions, limits and independent review remain required. Do not include duplicate contracts or references. This is only serialization, not permission to omit tests.`;
export function expandGameSpecification(text:string){
 const raw=parseJSON(text) as Record<string,unknown>;
 const finalContract=raw?.finalContract as Record<string,unknown>|undefined;
 const game=raw?.game as {acceptance?:{scenarios?:unknown}}|undefined;
 const scenarios=game?.acceptance?.scenarios;
 if(raw?.specificationFormat!==COMPACT_GAME_FORMAT)return raw;
 if(!finalContract||Object.keys(finalContract).join(',')!=='path'||!Array.isArray(raw.milestones)||raw.milestones.length!==1||
    !raw.milestones[0]||Object.keys(raw.milestones[0]).some(k=>!['title','instruction'].includes(k))||
    !Array.isArray(scenarios))throw Error('Compact game specification requires one milestone without contract and finalContract:{path}');
 const {specificationFormat,...plan}=raw;void specificationFormat;
 const contract={path:finalContract.path,scenarios:scenarios.filter((s):s is Record<string,unknown>=>Boolean(s)&&typeof s==='object'&&s.kind==='browser').map(s=>({name:s.id,steps:s.steps}))};
 return {...plan,finalContract:contract,milestones:[{...raw.milestones[0],contract}]};
}
export function validateGameSpecificationResponse(text:string){
 const plan=validateProjectPlan(expandGameSpecification(text));
 if(!plan.game)throw Error('Game specification requires source-grounded rules, a pure engine and registered acceptance');
 return plan;
}
export function compactValidatedGameSpecification(text:string){
 const plan=validateGameSpecificationResponse(text);
 if(plan.milestones.length!==1)return text;
 const {contract,...milestone}=plan.milestones[0];void contract;
 return canonical({...plan,specificationFormat:COMPACT_GAME_FORMAT,finalContract:{path:plan.finalContract.path},milestones:[milestone]});
}
export function specificationTextHash(text:string){return createHash('sha256').update(text).digest('hex');}
export function repairGameSpecification(base:string,hash:string,response:string){
 const patched=applyMissionRevisionPatch(base,hash,response);
 // No partial edit, inferred gameplay correction, or validator bypass.
 return {...patched,plan:validateGameSpecificationResponse(patched.text)};
}
