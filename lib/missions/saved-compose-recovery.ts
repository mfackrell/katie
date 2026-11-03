// Safely recover a previously billed research composer response whose only
// JSON formatting defect is a literal line break within a quoted string.
// Never fabricate content, omit required fields, bypass word limits or review.
import {createHash} from 'node:crypto';
export type RecoveredCompose={deliverable:string;composerNotes:string;sourceSha256:string;escapedLineBreaks:number};
export function recoverSavedResearchCompose(value:unknown):RecoveredCompose|null{
 if(typeof value!=='string'||value.length<2||Buffer.byteLength(value,'utf8')>20000)return null;
 let quoted=false,escaped=false,converted=0,normalized='';
 for(const char of value){
  if(quoted){
   if(escaped){normalized+=char;escaped=false;continue;}
   if(char==='\\'){normalized+=char;escaped=true;continue;}
   if(char==='"'){quoted=false;normalized+=char;continue;}
   if(char==='\n'||char==='\r'){
    normalized+=char==='\n'?'\\n':'\\r';converted++;continue;
   }
   if(char.charCodeAt(0)<32)return null;
  }else if(char==='"'){quoted=true;}
  normalized+=char;
 }
 if(quoted||escaped)return null;
 try{
  const parsed:unknown=JSON.parse(normalized);
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return null;
  const keys=Object.keys(parsed).sort();
  if(keys.join(',')!=='composerNotes,deliverable')return null;
  const v=parsed as Record<string,unknown>;
  if(typeof v.deliverable!=='string'||!v.deliverable.trim()||typeof v.composerNotes!=='string')return null;
  return{deliverable:v.deliverable,composerNotes:v.composerNotes,
   sourceSha256:createHash('sha256').update(value).digest('hex'),escapedLineBreaks:converted};
 }catch{return null;}
}
