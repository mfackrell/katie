/** Bound decision-model context after ranking the complete eligible inventory.
 * Retain the strongest candidates from EVERY provider; no fixed model IDs. */
export function shortlistDecisionCandidates<T extends {providerName:string}>(ranked:T[],perProvider?:number):T[]{
 if(perProvider===undefined)return ranked;
 const limit=Math.max(1,Math.min(8,Math.floor(perProvider)));
 const counts=new Map<string,number>();
 return ranked.filter(candidate=>{
  const count=counts.get(candidate.providerName)??0;
  if(count>=limit)return false;
  counts.set(candidate.providerName,count+1);return true;
 });
}
