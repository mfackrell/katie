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

// Binding discovery never depends on a feature gate: a disabled benchmark must
// fail closed rather than become an ordinary, unmetered project.
export function assertFullBenchmarkRuntime(env) {
 const decision=fullBenchmarkProjectDecision({candidate:true,
  databaseUrl:env.NEXT_PUBLIC_SUPABASE_URL,environment:env.KATIE_FULL_BENCHMARK_ENVIRONMENT,
  dispatchEnabled:env.KATIE_FULL_BENCHMARK_DISPATCH==='enabled',
  nativeDispatchEnabled:env.KATIE_NATIVE_BENCHMARK_DISPATCH==='enabled',
  trialId:env.KATIE_FULL_BENCHMARK_TRIAL_ID});
 if(decision!=='full')throw Error('Full benchmark runtime is not authorized');
}

export async function loadFullBenchmarkBinding(db,projectId,env) {
 if(!projectId)return null;
 const {data,error}=await db.from('benchmark_full_project_bindings')
  .select('trial_id,account_id,benchmark_contract_hash,baseline_sha,model')
  .eq('project_id',projectId).maybeSingle();
 if(error)throw Error('Full benchmark accounting binding lookup failed closed');
 if(data){
  assertFullBenchmarkRuntime(env);
  if(data.trial_id!==env.KATIE_FULL_BENCHMARK_TRIAL_ID)
   throw Error('Full benchmark runtime trial differs from the saved project binding');
 }
 return data;
}
