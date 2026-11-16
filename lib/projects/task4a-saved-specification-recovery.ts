import {digest,validateProjectPlan,type ProjectPlan} from './contract';

export const TASK4A_ORIGINAL_PROJECT='6d1c29f1-b31e-47a5-aabb-cbcf1326f388';
export const TASK4A_ORIGINAL_CHAT='e53defeb-16eb-457e-aa07-435141165ee8';
export const TASK4A_SPECIFICATION_MISSION='20a837cb-98ae-470f-8308-8526d8dceed3';
export const TASK4A_OLD_SOURCE_PATH='/project-pilots/task4a-preview-probe/';
export const TASK4A_NEW_SOURCE_PATH='app/project-pilots/task4a-preview-probe/';
const VALIDATION_ERROR='Scope requires isolated application/source/test paths; dependencies, secrets and deployment configuration need a separate decision';

export type SavedRecovery={
 sourceHash:string;reviewHash:string;correctedHash:string;
 corrected:ProjectPlan;
 sourceReviewOnly:true;
};

/** No generated content: a single known category-error correction on the saved revision. */
export function prepareTask4aSavedRecovery(savedRevision:string,missionResult:string,review:unknown):SavedRecovery{
 const original=JSON.parse(savedRevision) as Record<string,unknown>;
 const mission=JSON.parse(missionResult) as Record<string,unknown>;
 if(digest(original)!==digest(mission))throw Error('Original completed mission differs from saved revision');
 if(JSON.stringify(original.allowedPaths)!==JSON.stringify([TASK4A_OLD_SOURCE_PATH])||
  (original.finalContract as {path?:string}|undefined)?.path!==TASK4A_OLD_SOURCE_PATH)
  throw Error('Original Task 4A path failure is not the expected artifact');
 let knownError=false;
 try{validateProjectPlan(original);}
 catch(error){knownError=error instanceof Error&&error.message===VALIDATION_ERROR;}
 if(!knownError)throw Error('Original Task 4A validator failure is not the verified path error');
 const r=review as {verdict?:string;checks?:Array<{passed?:boolean}>};
 if(r?.verdict!=='pass'||!Array.isArray(r.checks)||r.checks.length!==6||r.checks.some(c=>c?.passed!==true))
  throw Error('Saved independent final review is not a complete PASS');
 const corrected=validateProjectPlan({...original,allowedPaths:[TASK4A_NEW_SOURCE_PATH]});
 if(digest(corrected.requirements)!==digest(original.requirements)||
    digest(corrected.milestones)!==digest(original.milestones)||
    digest(corrected.finalContract)!==digest(original.finalContract)||
    corrected.finalContract.path!==TASK4A_OLD_SOURCE_PATH)
  throw Error('Saved browser/requirements evidence changed during path recovery');
 return {sourceHash:digest(original),reviewHash:digest(review),
  correctedHash:digest(corrected),corrected,sourceReviewOnly:true};
}
