import {getSupabaseAdminClient} from '@/lib/data/supabase/admin';
import {projectRpc} from './store';
import {COMPACT_GAME_FORMAT,validateGameSpecificationResponse,specificationTextHash} from './game-specification-transport';

/** Correct a source-file/URL category error only when independent owner scope
 * and every saved browser navigation identify the same static application. */
export function repairSpecificationRoute(source:string,ownerScope:string){
 const raw=JSON.parse(source);
 if(raw?.specificationFormat!==COMPACT_GAME_FORMAT)return null;
 const scopeTokens=ownerScope.split(/[\s,;]+/).map(t=>t.replace(/\.+$/,''));
 const directories=[...new Set(scopeTokens.filter(t=>t.startsWith('app/')))];
 if(directories.length!==1||!/^app\/(?:[A-Za-z0-9_-]+\/)+$/.test(directories[0]))return null;
 const directory=directories[0],route='/'+directory.slice(4,-1),before=raw.finalContract?.path;
 if(typeof before!=='string'||!/^(?:tests|lib|components|public|docs)\/[A-Za-z0-9_./-]+\.(?:mjs|cjs|js|ts|tsx|jsx|json|md|html|css)$/.test(before)||!scopeTokens.includes(before)||
    !Array.isArray(raw.allowedPaths)||!raw.allowedPaths.includes(before)||!raw.allowedPaths.includes(directory))return null;
 const browser=raw.game?.acceptance?.scenarios?.filter((s:{kind:string})=>s.kind==='browser');
 if(!Array.isArray(browser)||!browser.length||browser.some((s:{steps?:Array<{action:string;path?:string}>})=>
   !Array.isArray(s.steps)||!s.steps.some(t=>t.action==='goto')||s.steps.some(t=>t.action==='goto'&&t.path!==route)))return null;
 const corrected={...raw,finalContract:{...raw.finalContract,path:route}};
 const correctedText=JSON.stringify(corrected);
 // Complete canonical validation, including expanded milestone, gameplay,
 // coverage and browser contracts. No repair is returned on any other defect.
 const plan=validateGameSpecificationResponse(correctedText);
 return {plan,sourceHash:specificationTextHash(source),correctedHash:specificationTextHash(correctedText),
  correction:{pointer:'/finalContract/path',before,after:route},correctedText};
}

export async function recoverSpecificationRoute(projectId:string){
 const db=getSupabaseAdminClient();
 const {data:p,error}=await db.from('work_projects').select('id,objective,clarifications,active_mission_id,status,phase').eq('id',projectId).maybeSingle<{id:string;objective:string;clarifications:string|null;active_mission_id:string|null;status:string;phase:string}>();
 if(error)throw Error('Specification route recovery project unavailable');
 if(!p||p.status!=='blocked'||p.phase!=='specification'||!p.active_mission_id)return false;
 const {data:jobs,error:jobError}=await db.from('mission_assignments').select('id,result').eq('mission_id',p.active_mission_id).eq('role','compose').eq('status','failed').returns<{id:string;result:Record<string,unknown>|null}>();
 if(jobError)throw Error('Specification route recovery source unavailable');
 if(jobs?.length!==1||typeof jobs[0].result?.rejectedSpecification!=='string')return false;
 const source=jobs[0].result.rejectedSpecification,scope=p.objective+'\n'+(p.clarifications??'');
 let repair;try{repair=repairSpecificationRoute(source,scope);}catch{return false;}
 if(!repair)return false;
 return projectRpc<boolean>('recover_specification_route',{p_id:p.id,p_job:jobs[0].id,p_source:source,p_original:jobs[0].result,p_scope:scope,p_plan:repair.plan});
}
