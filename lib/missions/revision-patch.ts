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
