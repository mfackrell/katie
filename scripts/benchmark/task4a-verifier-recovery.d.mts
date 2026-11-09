export const TASK4A_VERIFIER_EVIDENCE:Readonly<Record<string,string>>;
export function task4aVerifierReader(github:(path:string,binary?:boolean)=>Promise<any>):Promise<(path:string,binary?:boolean)=>Promise<any>>;
export function validateTask4aVerifierCheckpoint(record:unknown,diagnostics:unknown):{artifactId:string;artifactSha256:string;trustedJobId:string};
export function requireTask4aVerifierRestoration(record:unknown,recovery:unknown):true;
