import type {LifecycleProposal,LifecycleSnapshot} from '../../lib/projects/lifecycle-owner-types';
export function lifecycleProposalFromSnapshot(input:{snapshot:LifecycleSnapshot;record:unknown;observations?:unknown[];pricing?:unknown;now?:number}):{assessment:{uncertainties:string[]};state:string;proposal:LifecycleProposal|null;reasons?:string[]};
