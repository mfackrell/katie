import type {DeveloperDispatchPayload} from './developer-dispatch-contract.mjs';
import type {NativeDispatchPayload} from './native-dispatch-contract.mjs';
import type {ProviderExecutionProof} from './provider-execution-handoff.mjs';
type Proof=NativeDispatchPayload|DeveloperDispatchPayload|Omit<ProviderExecutionProof,'productionRuntime'>;
export function sealNativeProductionRuntime(serviceRoleKey:string,proof:Proof,key:string,now?:number):string;
export function openNativeProductionRuntime(value:string,proof:Proof,key:string,now?:number):{url:string;serviceRoleKey:string};
