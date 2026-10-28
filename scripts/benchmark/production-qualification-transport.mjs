import config from '../../config/benchmark-715-production-qualification.json' with {type:'json'};

// Vercel access is transport authentication only. The endpoint independently
// validates the signed owner run before any ledger mutation.
export function productionQualificationFetch(options, bypass, fetchImpl=fetch) {
 if(!bypass || typeof bypass!=='string' || /[\r\n]/.test(bypass))
  throw Error('PRODUCTION_VERCEL_ACCESS_REQUIRED: configure the existing Katie automation bypass in the GitHub Actions secret VERCEL_AUTOMATION_BYPASS_SECRET');
 const headers=new Headers(options?.headers);
 headers.set('x-vercel-protection-bypass',bypass);
 return fetchImpl(config.productionUrl+'/api/benchmark/715/owner-qualification',
  {...options,headers,redirect:'error'});
}
