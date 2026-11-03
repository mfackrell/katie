// Trusted GitHub workflow gate. The project context was validated by
// project-context.mjs, and native-dispatch-cli.mjs verified the signed manifest.
// Recheck the original signed request here: a missing/mismatched native authority
// must NEVER select the unmetered Codex action for the original Task 4A project.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readDeveloperHandoff} from './developer-dispatch-contract.mjs';

export const TASK4A_ORIGINAL_PROJECT='6d1c29f1-b31e-47a5-aabb-cbcf1326f388';

export function requireTask4aNativeGrant(request,project,manifest,key,now=Date.now()){
 if(project?.projectId!==TASK4A_ORIGINAL_PROJECT)return;
 if(manifest?.native!==true||manifest.authorityKind!=='task4a-developer')
  throw Error('TASK4A_NATIVE_AUTHORITY_REQUIRED');
 // Authenticate the actual request bytes, not a user-editable project marker
 // or the JSON manifest alone.
 const signed=readDeveloperHandoff(request,key,now);
 if(signed.authorityKind!=='task4a-developer'||
    signed.projectId!==TASK4A_ORIGINAL_PROJECT||
    signed.contractHash!==project.contractHash||
    signed.baselineSha!==project.baselineSha||
    project.codingModel!=='gpt-5.3-codex'||
    project.reviewModel!=='gpt-5.3-codex'||
    Object.keys(manifest).length!==Object.keys(signed).length+1||
    Object.entries(signed).some(([field,value])=>manifest[field]!==value))
  throw Error('TASK4A_NATIVE_AUTHORITY_MISMATCH');
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 try{
  if(process.argv.length!==5)throw Error('TASK4A_NATIVE_GATE_ARGUMENTS_INVALID');
  const request=readFileSync(process.argv[2],'utf8');
  const project=JSON.parse(readFileSync(process.argv[3],'utf8'));
  const manifest=JSON.parse(readFileSync(process.argv[4],'utf8'));
  requireTask4aNativeGrant(request,project,manifest,process.env.KATIE_NATIVE_HANDOFF_HMAC_KEY);
 }catch(error){
  console.error('TASK4A_NATIVE_DISPATCH_DENIED:',error?.message);
  process.exitCode=1;
 }
}
