import { createAccountingFetchWithPolicy, type AccountingTransmissionPolicy } from './dispatch';
import { runWithStandaloneActivity } from './context';
import type { AccountingProvider } from './pricing';
import { createMemoryMeteredFetch, MEMORY_ACTIVITIES } from '@/lib/memory/metered-fetch';
export function createActivityAccountingFetch(provider:AccountingProvider,activity:string,policy:AccountingTransmissionPolicy={}):typeof fetch {
  // Memory runs automatically as infrastructure. Track actual provider usage
  // without chat-lease authorization, owner budget limits, or accounting admission.
  if(MEMORY_ACTIVITIES.has(activity))return createMemoryMeteredFetch(provider,activity,policy);
  const transport=createAccountingFetchWithPolicy(provider,policy);
  return (input,init)=>runWithStandaloneActivity(activity,()=>transport(input,init));
}
