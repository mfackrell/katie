import {createHash} from 'node:crypto';

// Task 2B: proposals are evidence, never permission. Only the authenticated
// database transaction may turn a proposal into a spending amendment.
const canonical = value => JSON.stringify(value, (_key, item) => item &&
  typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export const proposalDigest = value => createHash('sha256').update(canonical(value)).digest('hex');
const integer = value => Number.isSafeInteger(value) && value >= 0;
const decimal = value => typeof value === 'string' && /^\d{1,18}(?:\.\d{1,12})?$/.test(value);
const scale = 10n ** 12n;
const money = value => { if (!decimal(value)) throw Error('Unknown monetary position');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * scale + BigInt(fraction.padEnd(12, '0'));
};
const moneyText = value => {
  const fraction = (value % scale).toString().padStart(12, '0').replace(/0+$/, '');
  return (value / scale).toString() + (fraction ? '.' + fraction : '');
};
const add = (...values) => {
  if (!values.every(integer)) throw Error('Unknown resource position');
  const result = values.reduce((a, b) => a + b, 0);
  if (!integer(result)) throw Error('Resource position exceeds safe range');
  return result;
};

/**
 * current is a trusted, coherent database snapshot, never browser input.
 * A minimum-only shortage is disclosed as such; unknown estimates stay null.
 * The immutable snapshot hash also binds receipts, reservations, grants and WIP.
 */
export function proposeLifecycleAmendment({assessment, current, now}) {
  if (!integer(now) || assessment?.version !== 'lifecycle-capacity-v1' ||
      assessment.kind !== 'forecast_not_authorization') throw Error('Invalid capacity assessment');
  if (!assessment.shortages?.length) return {state:'not_required', proposal:null};
  const unknown = [...assessment.uncertainties];
  if (!current || !/^[a-f0-9]{64}$/.test(current.snapshotHash ?? '') ||
      !assessment.evidence?.source ||
      Object.entries(assessment.binding).some(([key, value]) => !value || current.binding?.[key] !== value) ||
      assessment.evidence.checkpointSha !== current.checkpointSha ||
      !integer(assessment.observedAt) || assessment.observedAt > now || now-assessment.observedAt > 60000)
    return {state:'evidence_required', proposal:null, reasons:['Unverified or stale task/checkpoint/accounting snapshot']};
  if (current.revoked || current.frozen || current.admissionDenial)
    return {state:'admission_denied', proposal:null, reasons:[current.admissionDenial ?? 'Existing authority revoked or account frozen']};
  const position = current.position;
  const numeric = ['cumulativeTokens','developmentTokens','developmentCalls',
    'completionTokens','completionCalls','assessmentTokens','accountEncumberedTokens',
    'developmentEncumberedTokens','developmentConsumedCalls'];
  if (!position || !numeric.every(key => integer(position[key])) ||
      !['committedMicrousd','outstandingMicrousd','ceilingMicrousd'].every(key => decimal(position[key])) ||
      !integer(position.expiresAt) || !integer(current.originalWindowSeconds) || !current.originalWindowSeconds)
    return {state:'evidence_required', proposal:null, reasons:['Current authorized position is incomplete']};
  const d = assessment.dimensions;
  const shortage = key => {
    if (!assessment.shortages.includes(key)) return 0;
    const amount = d[key]?.shortfall ?? d[key]?.minimumShortfall;
    if (!integer(amount)) throw Error('Shortage amount is unknown: '+key);
    if (d[key].projectedRemaining === null) unknown.push(key+':minimum_only_amendment');
    return amount;
  };
  try {
    const requirement = key => {
      if (integer(d[key]?.projectedRemaining)) return d[key].projectedRemaining;
      if (assessment.shortages.includes(key)) {
        shortage(key); // Validate and disclose minimum-only requirements.
        if (!integer(d[key]?.minimumRemaining)) throw Error('Remaining requirement is unknown: '+key);
        return d[key].minimumRemaining;
      }
      return 0;
    };
    const completionTokens = Math.max(position.completionTokens, requirement('completionTokens'));
    const assessmentTokens = Math.max(position.assessmentTokens, requirement('assessmentTokens'));
    const completionCalls = Math.max(position.completionCalls, requirement('completionCalls'));
    const developmentTokens = Math.max(position.developmentTokens,
      add(position.developmentEncumberedTokens,completionTokens,requirement('nativeTokens')));
    const developmentCalls = Math.max(position.developmentCalls,
      add(position.developmentConsumedCalls,completionCalls,requirement('nativeCalls')));
    const assessmentCallAddition = shortage('assessmentCalls');
    const assessmentCalls = assessmentCallAddition ? add(position.assessmentCalls, assessmentCallAddition) : position.assessmentCalls;
    const cumulativeTokens = Math.max(position.cumulativeTokens,
      add(position.accountEncumberedTokens,requirement('totalTokens')),
      add(position.accountEncumberedTokens,completionTokens,assessmentTokens,requirement('nativeTokens')));
    let ceiling = money(position.ceilingMicrousd);
    if (assessment.shortages.includes('money')) {
      if (!decimal(d.money?.projectedRemaining)) throw Error('Remaining monetary requirement is unknown');
      const required = money(position.committedMicrousd)+money(position.outstandingMicrousd)+money(d.money.projectedRemaining);
      if (required > ceiling) ceiling = required;
    }
    const expired = position.expiresAt <= now;
    const renew = expired || assessment.shortages.includes('time');
    const seconds = d.time?.projectedRemaining;
    // A prior owner-selected window is an explicit proposed authorization window,
    // not a fabricated completion estimate. The unknown duration remains visible.
    const durationSeconds = renew ? Math.max(current.originalWindowSeconds, integer(seconds) ? seconds : 0) : null;
    if (renew && !integer(seconds)) unknown.push('continuation_window_reuses_prior_owner_window_duration_estimate_unknown');
    if (assessment.shortages.includes('executionAuthority') && !expired && !current.grantRenewable)
      return {state:'admission_denied', proposal:null, reasons:['Execution authority is unavailable for a reason other than expiration']};
    const proposed = {cumulativeTokens,developmentTokens,developmentCalls,assessmentCalls,
      completionTokens,completionCalls,assessmentTokens,ceilingMicrousd:moneyText(ceiling),
      expiresAt:renew ? null : position.expiresAt, durationSeconds,
      windowStartsAt:renew ? 'authenticated_commit' : 'unchanged'};
    const proposal = {version:'lifecycle-owner-proposal-v1',kind:'proposal_not_authorization',
      binding:assessment.binding,snapshotHash:current.snapshotHash,checkpointSha:current.checkpointSha,
      scope:current.scope,acceptance:current.acceptance,currentPhase:assessment.currentPhase,
      completed:assessment.stages.filter(s=>s.status==='completed').map(s=>s.stage),
      remaining:assessment.stages.filter(s=>!['completed','not_required'].includes(s.status)).map(s=>s.stage),
      current:position,proposed,
      additions:{tokens:cumulativeTokens-position.cumulativeTokens,nativeCalls:Math.max(0,developmentCalls-position.developmentCalls-(completionCalls-position.completionCalls)),
        developmentTokens:developmentTokens-position.developmentTokens,completionCalls:completionCalls-position.completionCalls,
        assessmentCalls:assessmentCallAddition,assessmentTokens:assessmentTokens-position.assessmentTokens},
      monetarySemantics:'ceilingMicrousd is a replacement cumulative maximum; estimatedIncrementalMicrousd is expected new spending, not added authority',
      estimatedIncrementalMicrousd:d.money?.expectedRemaining ?? null,
      conservativeIncrementalMicrousd:d.money?.projectedRemaining ?? null,
      shortages:assessment.shortages,uncertainties:[...new Set(unknown)].sort(),
      evidence:assessment.stages.map(s=>({stage:s.stage,evidence:s.evidence,confidence:s.confidence})),
      guaranteedCompletion:false,expiresAt:current.proposalExpiresAt};
    if (!integer(proposal.expiresAt) || proposal.expiresAt <= now || !proposal.scope || !proposal.acceptance)
      throw Error('Proposal scope, acceptance or expiration unavailable');
    const immutable = structuredClone(proposal);
    const freeze = value => {if(value && typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))freeze(child);}return value;};
    return {state:'awaiting_owner_approval',proposal:freeze({...immutable,id:proposalDigest(immutable)})};
  } catch(error) {
    return {state:'evidence_required',proposal:null,reasons:[error.message]};
  }
}

export function readableDollars(microusd) {
  if (microusd === null || microusd === undefined) return 'Unknown';
  const cents = (money(microusd) + 5000n*scale) / (10000n*scale);
  return '$'+(cents/100n).toString()+'.'+(cents%100n).toString().padStart(2,'0');
}
