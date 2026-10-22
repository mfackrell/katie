import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
export const REQUEST_ENVELOPE_VERSION = 1;
const limit=60000,maxBytes=1_000_000;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function packDevelopmentRequest(body,marker){
 if(typeof body!=='string'||Buffer.byteLength(body)>maxBytes||body.includes('<!-- katie-request-v1:'))throw Error('Coding request exceeds the lossless transport envelope or contains a reserved envelope marker');
 if(body.length<=limit)return body;
 const prefix=marker+'\n\n';if(!body.startsWith(prefix))throw Error('Coding request lacks its durable task marker');
 const bytes=Buffer.from(body.slice(prefix.length));
 const packed=prefix+'<!-- katie-request-v1: '+hash(bytes)+':'+gzipSync(bytes).toString('base64url')+' -->';
 if(packed.length>limit)throw Error('Complete coding request cannot fit the bounded GitHub transport; all source remains saved and no issue was submitted');
 return packed;
}
export function unpackDevelopmentRequest(request){
 if(typeof request!=='string'||Buffer.byteLength(request)>maxBytes)throw Error('Coding request exceeds its transport bound');
 if(!request.includes('<!-- katie-request-v1:'))return request;
 const match=request.match(/^((?:[^\n]{1,300}\n\n)?<!-- katie-managed-task:[0-9a-f-]{36} -->\n\n)<!-- katie-request-v1: ([0-9a-f]{64}):([A-Za-z0-9_-]+) -->\s*$/);
 if(!match||request.length>65536)throw Error('Malformed coding request envelope');
 const packed=Buffer.from(match[3],'base64url');if(packed.toString('base64url')!==match[3])throw Error('Noncanonical coding request envelope');
 const bytes=gunzipSync(packed,{maxOutputLength:maxBytes});
 if(hash(bytes)!==match[2])throw Error('Coding request digest mismatch');
 const body=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
 if(body.includes('<!-- katie-request-v1:'))throw Error('Nested coding request envelope');
 return match[1]+body;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{if(process.argv.length!==4||process.argv[2]!=='unpack')throw Error('Usage: request-envelope.mjs unpack REQUEST.md');
 const path=process.argv[3];writeFileSync(path,unpackDevelopmentRequest(readFileSync(path,'utf8')));
 }catch(error){console.error(error.message);process.exitCode=1;}
}
