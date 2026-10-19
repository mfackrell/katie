import type {ProjectPlan} from './contract';
import type {Project} from './store';

// Match jsonb::text separators, without charging pretty-print indentation.
// JS UTF-16 length conservatively overcounts astral Unicode versus PostgreSQL.
export function jsonbTextSize(value:unknown):number{
 const normalized=JSON.parse(JSON.stringify(value));
 const count=(v:unknown):number=>{
  if(Array.isArray(v))return 2+v.reduce((n,x)=>n+count(x),0)+Math.max(0,v.length-1)*2;
  if(v&&typeof v==='object'){const entries=Object.entries(v);return 2+entries.reduce((n,[k,x])=>n+JSON.stringify(k).length+2+count(x),0)+Math.max(0,entries.length-1)*2;}
  const text=JSON.stringify(v);
  if(typeof v==='number'&&/e/i.test(text)){
   const [mantissa,exponent]=text.toLowerCase().split('e'),negative=mantissa.startsWith('-'),digits=mantissa.replace('-','').replace('.',''),point=(mantissa.replace('-','').split('.')[0].length)+Number(exponent);
   return (negative?1:0)+(point<=0?2-point+digits.length:point>=digits.length?point:digits.length+1);
  }
  return text.length;
 };
 return count(normalized);
}
const size=jsonbTextSize;
export function gameAssessmentCapacity(plan:ProjectPlan){
 if(!plan.game)return null;
 const checks=plan.finalContract.scenarios.map(s=>({name:s.name,passed:true,detail:'x'.repeat(100)}));
 const fixed={gameRules:plan.game.rules,approvedFinalContract:plan.finalContract,previewChecks:checks,incrementChecks:checks,url:'x'.repeat(2000)};
 // Reserve 7 KB for immutable receipts, phase history and identifiers. The
 // remaining 6 KB below the SQL cap is for bounded actual source excerpts.
 return {requiredCharacters:size(fixed)+7000,maximumCharacters:24000};
}
export function validateGameAssessmentCapacity(plan:ProjectPlan){
 const capacity=gameAssessmentCapacity(plan);
 if(capacity&&capacity.requiredCharacters>capacity.maximumCharacters)throw Error(`Game specification exceeds the final assessment evidence capacity: ${capacity.requiredCharacters} characters required, maximum ${capacity.maximumCharacters}. Compact rule descriptions and consolidate repeated browser setup before scope approval; preserve every original requirement.`);
}
export function gameAssessmentEvidence(p:Project,history:Array<{phase:string;index:number;status:string;head?:unknown}>,outcome:Record<string,unknown>|null){
 const v=outcome?.verification as Record<string,unknown>|undefined;
 const files=(Array.isArray(v?.changedFiles)?v.changedFiles:[]) as Array<Record<string,unknown>>;
 const proof=v?{
  head:outcome?.head,taskId:outcome?.taskId,
  verification:{pullRequest:v.pullRequest,observedHeadSha:v.observedHeadSha,testedHeadSha:v.testedHeadSha,reviewedHeadSha:v.reviewedHeadSha,baseSha:v.baseSha,
   projectAcceptance:v.projectAcceptance,changedFileCount:files.length,changedFiles:[] as Record<string,unknown>[],omittedFileCount:0,
   sourceNote:'Bounded actual source excerpts; the complete independently reviewed diff and original receipts remain on the saved PR/task. Missing excerpts are not missing implementation.'}
 }:null;
 const result={milestones:history,approvedFinalContract:p.spec!.finalContract,approvedScopeHash:p.approved_hash,finalIntegratedEvidence:proof,preview:p.preview,gameRules:p.spec!.game!.rules};
 if(size(result)>24000)throw Error('Saved game receipts exceed the pre-approved assessment envelope; preserve them for diagnosis rather than truncate rules or browser evidence');
 if(proof)for(const file of files){
  const compact={path:file.path,status:file.status,additions:file.additions,deletions:file.deletions,...(typeof file.patch==='string'?{patch:file.patch}:{patchUnavailable:true})};
  proof.verification.changedFiles.push(compact);
  if(size(result)>29000){
   proof.verification.changedFiles.pop();
   proof.verification.changedFiles.push({path:file.path,status:file.status,patchUnavailable:true});
   if(size(result)>29000){proof.verification.changedFiles.pop();proof.verification.omittedFileCount++;}
  }
 }
 return result;
}
