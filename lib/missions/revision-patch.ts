import {createHash} from 'node:crypto';
import {missionRevisionPatchSchema,parseJSON} from './types';

/** Exact edits against the immutable reviewed candidate. Only declared spans
 * may change; the server never infers a correction or approves the result. */
export function applyMissionRevisionPatch(base:string,expectedHash:string,response:string){
 const actualHash=createHash('sha256').update(base).digest('hex');
 if(actualHash!==expectedHash)throw Error('Targeted revision base changed');
 const patch=missionRevisionPatchSchema.parse(parseJSON(response));
 const edits=patch.edits.map(edit=>{
  const start=base.indexOf(edit.before);
  if(start<0||base.indexOf(edit.before,start+1)!==-1)throw Error('Revision edit must match exactly one original span');
  if(edit.before===edit.after)throw Error('Revision edit made no change');
  return{...edit,start,end:start+edit.before.length};
 }).sort((a,b)=>a.start-b.start);
 if(edits.some((edit,index)=>index>0&&edit.start<edits[index-1].end))throw Error('Revision edits overlap');
 if(edits.reduce((n,e)=>n+e.before.length,0)>Math.min(6000,Math.ceil(base.length*0.35)))throw Error('Targeted revision exceeds its narrow change allowance');
 let text=base;for(const edit of [...edits].reverse())text=text.slice(0,edit.start)+edit.after+text.slice(edit.end);
 if(text.length<base.length*0.6||text.length>base.length+4000)throw Error('Targeted revision changed too much content');
 return{text,composerNotes:patch.composerNotes,revisionPatch:{baseHash:actualHash,resultHash:createHash('sha256').update(text).digest('hex'),edits:patch.edits}};
}

/** Recover only a fully returned edits array. Never infer a missing character,
 * replacement, or reviewer verdict. Truncated internal notes are not a deliverable. */
export function recoverMissionRevisionPatch(base:string,expectedHash:string,partial:string){
 const prefix=/^\s*\{\s*"edits"\s*:\s*\[/.exec(partial);
 if(!prefix)throw Error('No complete leading edits array');
 const start=prefix[0].length-1;let depth=0,quoted=false,escaped=false,end=-1;
 for(let i=start;i<partial.length;i++){
  const ch=partial[i];
  if(quoted){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;continue;}
  if(ch==='"'){quoted=true;continue;}
  if(ch==='[')depth++;else if(ch===']'&&--depth===0){end=i+1;break;}
 }
 if(end<0)throw Error('Edits array itself is incomplete');
 const tail=partial.slice(end).trim();
 if(tail){const key=/^,\s*"([^"]*)/.exec(tail);if(!key||!('composerNotes'.startsWith(key[1])||key[1]==='composerNotes'))throw Error('Truncation is not confined to private notes');}
 const edits=JSON.parse(partial.slice(start,end));
 const result=applyMissionRevisionPatch(base,expectedHash,JSON.stringify({edits,composerNotes:''}));
 return{...result,recoveredPatch:{partialHash:createHash('sha256').update(partial).digest('hex'),notesIncomplete:true,independentReviewRequired:true}};
}

/** A stream can end inside its last edit. Retain only preceding, fully parsed
 * edits; never fill a missing character or apply the unfinished replacement.
 * This is an unapproved candidate, still subject to length and full review. */
export function recoverMissionRevisionPrefix(base:string,expectedHash:string,partial:string){
 const prefix=/^\s*\{\s*"edits"\s*:\s*\[/.exec(partial);
 if(!prefix)throw Error('Missing leading edits array');
 let offset=prefix[0].length;const edits:unknown[]=[];
 while(offset<partial.length){
  while(/\s/.test(partial[offset]??''))offset++;
  if(partial[offset]!=='{')throw Error('Expected an edit object');
  let depth=0,quoted=false,escaped=false,end=-1;
  for(let i=offset;i<partial.length;i++){
   const ch=partial[i];
   if(quoted){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;continue;}
   if(ch==='"'){quoted=true;continue;}
   if(ch==='{')depth++;else if(ch==='}'&&--depth===0){end=i+1;break;}
  }
  if(end<0){
   if(!edits.length)throw Error('No complete edits to recover');
   const result=applyMissionRevisionPatch(base,expectedHash,JSON.stringify({edits,composerNotes:''}));
   return{...result,recoveredPatch:{partialHash:createHash('sha256').update(partial).digest('hex'),completeEditCount:edits.length,unfinishedEditOmitted:true,independentReviewRequired:true},changedCharacters:result.revisionPatch.edits.reduce((n,e)=>n+e.before.length,0)};
  }
  edits.push(JSON.parse(partial.slice(offset,end)));offset=end;
  while(/\s/.test(partial[offset]??''))offset++;
  if(partial[offset]!==',')throw Error('Expected an unfinished final edit after the complete prefix');
  offset++;
 }
 throw Error('Missing unfinished edit');
}
