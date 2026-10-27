const STAGING_SUPABASE_URL='https://iytvavgbaainnsrecmcx.supabase.co';
const PRODUCTION_SUPABASE_URL='https://barclcqataqyvifoeyop.supabase.co';

/**
 * Decide whether the exact Take Eleven benchmark is bound to a recognized
 * database and both trusted dispatch gates. Production additionally requires
 * an explicit environment opt-in. Never fall back to an ordinary game project
 * for a benchmark request when the database is recognized but unconfigured.
 */
export function fullBenchmarkProjectDecision({
  candidate,databaseUrl,environment,dispatchEnabled,nativeDispatchEnabled,trialId
}) {
  if(!candidate)return 'ordinary';
  let url=typeof databaseUrl==='string'?databaseUrl:'';
  while(url.endsWith('/'))url=url.slice(0,-1);
  const staging=url===STAGING_SUPABASE_URL;
  const production=url===PRODUCTION_SUPABASE_URL;
  if(!staging&&!production)return 'ordinary';
  if(!dispatchEnabled||!nativeDispatchEnabled||!trialId)return 'blocked';
  if(production&&environment!=='production')return 'blocked';
  return 'full';
}
