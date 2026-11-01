import type {LifecycleProposal} from './lifecycle-owner-types';
export function proposalDigest(value:unknown):string;
export function readableDollars(value:string|null|undefined):string;
export function proposeLifecycleAmendment(value:unknown):{state:string;proposal:LifecycleProposal|null;reasons?:string[]};
