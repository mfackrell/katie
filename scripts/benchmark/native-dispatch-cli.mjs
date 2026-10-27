import {readFileSync,writeFileSync} from 'node:fs';
import {readNativeHandoff} from './native-dispatch-contract.mjs';
// Invoked ONLY from trusted workflow checkout before candidate baseline switch.
const [,,command,source,destination]=process.argv;
if(command!=='verify'||!source||!destination)throw Error('NATIVE_HANDOFF_CLI_INVALID');
const body=readFileSync(source,'utf8');
const tagged=/<!--\s*katie-native-benchmark[:\s]/.test(body);
if(!tagged){writeFileSync(destination,JSON.stringify({native:false}));process.exit(0);}
const payload=readNativeHandoff(body,process.env.KATIE_NATIVE_HANDOFF_HMAC_KEY);
const projectMatch=body.match(/<!-- katie-project: ([A-Za-z0-9_-]+) -->/);
if(!projectMatch)throw Error('NATIVE_PROJECT_BINDING_MISSING');
let project;try{project=JSON.parse(Buffer.from(projectMatch[1],'base64url').toString())}
catch{throw Error('NATIVE_PROJECT_BINDING_INVALID')}
if(project.projectId!==payload.projectId||project.contractHash!==payload.contractHash||
   project.benchmarkContractHash!==payload.benchmarkContractHash||project.baselineSha!==payload.baselineSha)
 throw Error('NATIVE_HANDOFF_PROJECT_MISMATCH');
writeFileSync(destination,JSON.stringify({native:true,...payload}));
