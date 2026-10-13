// Explicit operator tool. Never called from build, tests, cron, deployment or chat.
const action = process.argv[2] ?? 'status';
if (!['status','run','cleanup'].includes(action)) throw new Error('Use status, run, or cleanup');
const origin = new URL(process.env.KATIE_OPERATOR_ORIGIN ?? 'http://localhost');
if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/')
  throw new Error('Set KATIE_OPERATOR_ORIGIN to the trusted HTTPS application origin');
const token = process.env.RUNPOD_INTERNAL_TOKEN;
if (!token || token.length < 32) throw new Error('Provide the existing admin token through the operator environment');
const url = new URL('/api/internal/runpod-results/synthetic',origin);
async function call(method) {
  const response = await fetch(url,{method,headers:{'x-runpod-admin-token':token},signal:AbortSignal.timeout(50000),redirect:'error'});
  // Server responses are sanitized. Never print headers or raw failure bodies.
  if (!response.ok) throw new Error(`Synthetic harness HTTP ${response.status}`);
  const result = await response.json();
  console.log(JSON.stringify(result));
  return result;
}
if (action === 'status') await call('GET');
else if (action === 'cleanup') await call('DELETE');
else {
  if (process.env.KATIE_SYNTHETIC_COST_APPROVED !== 'one-post-60-gpu-seconds')
    throw new Error('Approve the one-POST, 60-second RunPod execution cap in KATIE_SYNTHETIC_COST_APPROVED');
  // A failed/uncertain POST is never repeated automatically. Inspect status, then clean up.
  await call('POST');
  let elapsed = 0;
  while (elapsed < 1200) {
    const state = await call('GET');
    if (state.status === 'not_started' || state.status === 'cleaned') break;
    elapsed = state.elapsedSeconds;
    if (elapsed >= 1200) {await call('DELETE');break;}
    await new Promise(resolve=>setTimeout(resolve,15000));
  }
}
