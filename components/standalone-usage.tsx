'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ownerSessionBearer } from '@/lib/tools/browser-owner-session';
import type { DailyUsage, UsageTotals } from '@/lib/standalone-accounting/daily';

interface Configuration { timezone: string; per_call_limit_microusd: string | null; request_limit_microusd: string | null; budget_revision: number }
interface Pending { id: string; requestId: string; provider: string; model: string; category: string; preparedHash: string; pricingVersion: string; budgetRevision: number; reservedMicrousd: string; reason: string; pauseReason: string | null; resolvedModel: string | null; estimatorVersion: string; tradeoffs: string | null; createdAt: string; preview: { textBytes: number; imageCount: number; imageBytes: number; inputTokens: number; imageTokens: number; outputAllowance: number; assumptions: string[]; issues: string[]; status: string }; requestExposure: UsageTotals }
type DecisionAttempt = Pick<Pending, 'id' | 'requestId' | 'preparedHash' | 'pricingVersion' | 'budgetRevision' | 'reservedMicrousd'>;
interface ActiveAttempt extends DecisionAttempt { provider: string; model: string; category: string; state: 'reserved' | 'dispatched' | 'uncertain'; parentStatus?: string; continuationActionable?: boolean; exposureAccepted?: boolean; continuationBlockedReason?: string | null; pollableRunpod?: boolean }
interface Snapshot { configuration: Configuration | null; daily: DailyUsage | null; pending: Pending[]; active?: ActiveAttempt[]; alerts?: Array<{ attemptId: string; provider: string; model: string; kind: string; message: string; actualMicrousd: string | null; reservedMicrousd: string }> }
interface Props { rail?: boolean; actorId: string; chatId: string; onResumeAttempt?: (attempt: { attemptId: string; requestId: string }) => Promise<void> | void }

// Formatting uses integer arithmetic so large ledger amounts never lose precision.
function dollars(value: string) {
  const amount = BigInt(value), fraction = (amount % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `$${(amount / 1_000_000n).toString()}${fraction ? `.${fraction}` : '.00'}`;
}
function decimal(value: string | null) { return value === null ? '' : dollars(value).slice(1); }
function parseDollars(value: string) {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) throw Error('Enter a nonnegative USD amount with up to six decimal places.');
  const [whole, fraction = ''] = value.split('.');
  return (BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))).toString();
}
function Tokens({ totals }: { totals: UsageTotals }) {
  return <span>In {totals.inputTokens.toLocaleString()}{totals.missingInputCount > 0 && ` + unknown (${totals.missingInputCount})`} · Out {totals.outputTokens.toLocaleString()}{totals.missingOutputCount > 0 && ` + unknown (${totals.missingOutputCount})`}</span>;
}

function displayedCost(totals: UsageTotals) {
  return dollars((BigInt(totals.estimatedCostMicrousd) + BigInt(totals.estimatedInfrastructureMicrousd ?? '0')).toString());
}

function InfrastructureEstimate({totals}: {totals: UsageTotals}) {
  return BigInt(totals.estimatedInfrastructureMicrousd ?? '0') > 0n
    ? <span>RunPod estimated infrastructure cost {dollars(totals.estimatedInfrastructureMicrousd!)} · actual cost unconfirmed</span> : null;
}
function ProviderUsage({provider}: {provider: UsageTotals & {provider: string}}) {
  if (provider.provider === 'runpod') return <>
    <InfrastructureEstimate totals={provider}/>
    {(BigInt(provider.estimatedCostMicrousd) > 0n || provider.unknownCostCount === 0) && <span>{BigInt(provider.estimatedInfrastructureMicrousd ?? '0') > 0n ? ' · ' : ''}RunPod actual cost {dollars(provider.estimatedCostMicrousd)}</span>}
    {provider.unknownCostCount > 0 && BigInt(provider.estimatedInfrastructureMicrousd ?? '0') === 0n && <span>RunPod · actual cost unconfirmed</span>}
  </>;
  return <><strong>{provider.provider}</strong> <Tokens totals={provider}/> · {dollars(provider.estimatedCostMicrousd)}</>;
}
function ModelCost({model}: {model: UsageTotals & {provider: string}}) {
  if (model.provider === 'runpod') return <ProviderUsage provider={model}/>;
  return <>{dollars(model.estimatedCostMicrousd)}{model.unknownCostCount > 0 && ' + unknown'}</>;
}

export function StandaloneUsage({ actorId, chatId, onResumeAttempt, rail = false }: Props) {
  const refreshSequence = useRef(0);
  const invalidateRefresh = useCallback(() => { refreshSequence.current++; }, []);
  const [scope, setScope] = useState<'this-agent' | 'all'>('this-agent');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [error, setError] = useState(''), [refreshError, setRefreshError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState('');
  const [usageOpen, setUsageOpen] = useState(false), [reviewOpen, setReviewOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false), [timezone, setTimezone] = useState(''), [callLimit, setCallLimit] = useState(''), [requestLimit, setRequestLimit] = useState('');
  const api = useCallback(async (path: string, init?: RequestInit) => {
    const bearer = await ownerSessionBearer();
    if (!bearer) throw Error('Sign in as the owner to view usage and approve paid calls.');
    const response = await fetch(`/api/standalone-accounting/${path}`, { ...init, cache: 'no-store', headers: { ...init?.headers, Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' } });
    const body = await response.json();
    if (!response.ok) throw Error(body.error || 'Accounting is unavailable.');
    return body;
  }, []);
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    try {
      const result = await api(`usage?${new URLSearchParams({ actorId, chatId, scope })}`) as Snapshot;
      if (sequence !== refreshSequence.current) return;
      setSnapshot(result); setRefreshError('');
    } catch (failure) { if (sequence === refreshSequence.current) setRefreshError(failure instanceof Error ? failure.message : 'Accounting is unavailable.'); }
  }, [api, actorId, chatId, scope]);
  useEffect(() => {
    setSnapshot(null); void refresh();
    const update = () => { void refresh(); };
    const timer = window.setInterval(update, 15000);
    window.addEventListener('focus', update); window.addEventListener('standalone-accounting-updated', update);
    return () => { invalidateRefresh(); clearInterval(timer); window.removeEventListener('focus', update); window.removeEventListener('standalone-accounting-updated', update); };
  }, [refresh, invalidateRefresh]);
  function openSettings() {
    const config = snapshot?.configuration;
    setTimezone(config?.timezone ?? ''); setCallLimit(decimal(config?.per_call_limit_microusd ?? null)); setRequestLimit(decimal(config?.request_limit_microusd ?? null));
    setReviewOpen(false); setUsageOpen(true); setSettingsOpen(true);
  }
  async function saveSettings(event: React.FormEvent) {
    event.preventDefault(); setBusy('settings'); setError('');
    try {
      await api('configuration', { method: 'PATCH', body: JSON.stringify({ actorId, chatId, timezone, perCallLimitMicrousd: parseDollars(callLimit), requestLimitMicrousd: parseDollars(requestLimit) }) });
      setSettingsOpen(false); setNotice('Settings saved. Existing approvals require the current budget revision.'); await refresh();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Settings could not be saved.'); }
    finally { setBusy(''); }
  }
  async function requestSavedResume(detail: { attemptId: string; requestId: string }) {
    if (onResumeAttempt) await onResumeAttempt(detail);
    else await new Promise<void>((resolve, reject) => {
      window.dispatchEvent(new CustomEvent('standalone-accounting-resume', { detail: { ...detail, actorId, chatId, resolve, reject } }));
    });
  }
  async function resumeReserved(attempt: ActiveAttempt) {
    if (attempt.continuationActionable !== true || attempt.continuationBlockedReason || (attempt.state !== 'reserved' && !attempt.pollableRunpod)) return;
    setBusy(attempt.id); setError(''); setNotice('');
    try {
      await requestSavedResume({ attemptId: attempt.id, requestId: attempt.requestId });
      setNotice('Saved work completed.');
      await refresh();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Saved work could not resume.'); }
    finally { setBusy(''); }
  }
  async function acceptExposure(attempt: ActiveAttempt) {
    if (attempt.continuationActionable !== true || attempt.continuationBlockedReason || attempt.state !== 'uncertain' || !snapshot?.configuration) return;
    setBusy(attempt.id); setError(''); setNotice('');
    const retained = `Uncertain exposure accepted · ${dollars(attempt.reservedMicrousd)} retained`;
    let accepted = false;
    try {
      const result = await api('attempts', { method: 'POST', body: JSON.stringify({ actorId, chatId, attemptId: attempt.id, action: 'accept_exposure', preparedHash: attempt.preparedHash, pricingVersion: attempt.pricingVersion, budgetRevision: snapshot.configuration.budget_revision, reservedMicrousd: attempt.reservedMicrousd }) });
      accepted = true; setNotice(`${retained} · continuing remaining work`);
      await requestSavedResume({ attemptId: result.attemptId as string, requestId: result.requestId as string });
      setNotice(`${retained} · remaining work completed`);
    } catch (failure) {
      if (accepted) setNotice(`${retained} · continuation stopped`);
      setError(failure instanceof Error ? failure.message : 'Remaining work could not continue.');
    }
    finally { await refresh(); setBusy(''); }
  }
  async function decide(attempt: DecisionAttempt, action: 'approve_once' | 'reduce_cost' | 'cancel') {
    setBusy(attempt.id); setError(''); setNotice('');
    try {
      const result = await api('attempts', { method: 'POST', body: JSON.stringify({ actorId, chatId, attemptId: attempt.id, action, preparedHash: attempt.preparedHash, pricingVersion: attempt.pricingVersion, budgetRevision: attempt.budgetRevision, reservedMicrousd: attempt.reservedMicrousd }) });
      if (action === 'approve_once') {
        await requestSavedResume({ attemptId: result.attemptId as string, requestId: result.requestId as string });
        setNotice('Approved saved work completed.');
      } else setNotice(action === 'cancel' ? result.message || 'Cancellation requested. Any dispatched spending exposure remains visible.' : 'A smaller proposal was prepared. Review its new estimate before approval.');
      await refresh();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Decision could not be saved.'); await refresh(); }
    finally { setBusy(''); }
  }
  const daily = snapshot?.daily;
  const activeAttempts = snapshot?.active ?? [];
  const configurationComplete = snapshot?.configuration && snapshot.configuration.per_call_limit_microusd !== null && snapshot.configuration.request_limit_microusd !== null;
  const approvals = snapshot?.pending.length ?? 0;
  const unresolved = activeAttempts.length;
  const alerts = snapshot?.alerts?.length ?? 0;
  if (rail) return <section aria-label="Standalone daily usage" className="space-y-4 text-xs text-zinc-300">
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-white">Daily usage</h3>
      <div className="flex flex-wrap gap-2"><label>Scope <select aria-label="Scope" className="rounded bg-zinc-900 p-1" value={scope} onChange={e=>setScope(e.target.value as typeof scope)}><option value="this-agent">This agent</option><option value="all">All standalone</option></select></label><button type="button" className="underline" onClick={openSettings}>Budget & timezone</button><button type="button" className="underline" onClick={()=>void refresh()}>Refresh</button></div>
      {daily ? <div className="space-y-1"><p>Today <strong>{displayedCost(daily.totals)}</strong>{BigInt(daily.totals.estimatedInfrastructureMicrousd ?? '0') > 0n && ' including infrastructure estimate'}</p><p>Pending {dollars(daily.totals.pendingExposureMicrousd)}</p><p>Uncertain {dollars(daily.totals.uncertainExposureMicrousd)}</p><p><Tokens totals={daily.totals}/></p>{daily.totals.estimatedInfrastructureMicrousd !== '0' && <p><InfrastructureEstimate totals={daily.totals}/></p>}{daily.providers.map(provider=><p key={provider.provider}><ProviderUsage provider={provider}/></p>)}</div> : <p>{error || refreshError || "Loading usage…"}</p>}
      <details className="rounded border border-white/10 p-2"><summary className="cursor-pointer">Models, activity & earlier exposure</summary>
    {daily && <>
      <p className="mt-2">{daily.date} · {daily.timezone} · Estimated cost {displayedCost(daily.totals)} · Pending {dollars(daily.totals.pendingExposureMicrousd)} · Uncertain {dollars(daily.totals.uncertainExposureMicrousd)}</p>
      <p className="mt-1"><InfrastructureEstimate totals={daily.totals}/></p>
      <p className="mt-1"><Tokens totals={daily.totals} />{daily.totals.unknownCostCount > 0 && ` · ${daily.totals.unknownCostCount} call(s) with unknown cost; displayed cost is incomplete.`}</p>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1">{daily.providers.map(provider => <p key={provider.provider}><ProviderUsage provider={provider}/></p>)}</div>
      {daily.unresolvedEarlier.attemptCount > 0 && <p className="mt-2 rounded border border-amber-400/30 p-2 text-amber-200">Earlier unresolved exposure ({daily.unresolvedEarlier.attemptCount} attempts): pending {dollars(daily.unresolvedEarlier.pendingExposureMicrousd)} · uncertain {dollars(daily.unresolvedEarlier.uncertainExposureMicrousd)}. Kept separate from today; still reserved on the original requests.</p>}
      <details className="mt-2"><summary className="cursor-pointer">Models & activity, including hidden helpers ({daily.totals.attemptCount} attempts)</summary>
        <div className="mt-2 overflow-x-auto"><table className="w-full text-left"><thead><tr><th className="pr-4">Provider / model</th><th className="pr-4">Activity</th><th className="pr-4">Tokens</th><th>Estimated cost</th></tr></thead><tbody>{daily.models.map(model => <tr key={JSON.stringify([model.provider, model.model, model.category])}><td className="py-1 pr-4">{model.provider} / {model.model}</td><td className="pr-4">{model.category}</td><td className="pr-4"><>{model.provider === 'runpod' ? 'Infrastructure billing' : <Tokens totals={model}/>}</></td><td><ModelCost model={model}/></td></tr>)}</tbody></table></div>
        <ul className="mt-2 space-y-1">{daily.attempts.map(attempt => <li key={attempt.id}>{new Intl.DateTimeFormat(undefined, { timeZone: daily.timezone, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(attempt.dispatched_at || attempt.created_at))} · {attempt.provider}/{attempt.model} · {attempt.category} · {attempt.state} · {attempt.actual_microusd === null ? (attempt.provider === 'runpod' && attempt.state === 'estimated' ? `estimated infrastructure cost ${dollars(attempt.reserved_microusd)} · actual cost unconfirmed` : 'cost unknown / not settled') : dollars(attempt.actual_microusd)}</li>)}</ul>
      </details>
    </>}


      </details>
    </section>
    {(snapshot?.pending.length || activeAttempts.length) ? <section className="space-y-2"><h3 className="text-sm font-semibold text-amber-100">Active / unresolved work</h3>
    {activeAttempts.length > 0 && <div aria-label="Active attempts in this conversation" className="mt-2 space-y-2">
      <p className="font-medium text-zinc-100">Active or unresolved attempts in this conversation</p>
      {activeAttempts.map(attempt => <div key={attempt.id} className="rounded border border-white/20 p-2">
        <p>{attempt.provider}/{attempt.model} · {attempt.category} · {attempt.state} · exposure {dollars(attempt.reservedMicrousd)}</p>
        <p className="mt-1 break-all text-zinc-400">Exact attempt {attempt.id} · original request {attempt.requestId}</p>
        {attempt.continuationActionable !== true && <p role="status" className="mt-1 text-amber-100">{attempt.state === 'uncertain' ? 'Uncertain exposure retained' : 'Exposure retained'} · parent request {attempt.parentStatus === 'completed' ? 'already completed' : attempt.parentStatus === 'running' ? 'already running' : attempt.parentStatus ?? 'not resumable'}</p>}
        {attempt.continuationBlockedReason && <p role="alert" className="mt-1 text-amber-200">{attempt.continuationBlockedReason} This technical limitation cannot be changed by continuing the same request.</p>}
        {(attempt.state === 'reserved' || attempt.pollableRunpod) && attempt.continuationActionable === true && !attempt.continuationBlockedReason && <button type="button" disabled={Boolean(busy)} onClick={() => void resumeReserved(attempt)} className="mr-4 mt-1 rounded border border-white/30 px-2 py-1 disabled:opacity-50">{attempt.pollableRunpod ? 'Check saved Qwen analysis' : 'Resume saved work'}</button>}
        {attempt.state === 'uncertain' && attempt.continuationActionable === true && <>
          <p className="mt-1">The provider call was already sent, but exact usage/cost could not be confirmed. Continuing will retain the full reserved exposure and will not resend this attempt.</p>
          {attempt.exposureAccepted && <p className="mt-1 text-amber-100">Uncertain exposure accepted · {dollars(attempt.reservedMicrousd)} retained</p>}
          {!attempt.continuationBlockedReason && !attempt.pollableRunpod && <button type="button" disabled={Boolean(busy) || !configurationComplete} onClick={() => void acceptExposure(attempt)} className="mr-4 mt-1 rounded border border-amber-300/50 px-2 py-1 disabled:opacity-50">{attempt.exposureAccepted ? 'Continue remaining work' : 'Accept exposure & continue'}</button>}
        </>}
        {attempt.pollableRunpod && <p className="mt-1">Qwen image analysis was already submitted. Checking the saved analysis polls that existing job and will not submit another image analysis.</p>}
        {attempt.state === 'dispatched' && !attempt.pollableRunpod && <p className="mt-1">Already dispatched. Cancellation stops remaining work where possible; spending exposure stays held until provider usage is reconciled.</p>}
        {attempt.continuationActionable === true && <button type="button" disabled={Boolean(busy)} onClick={() => void decide(attempt, 'cancel')} className="mt-1 underline disabled:opacity-50">Cancel remaining work</button>}
      </div>)}
    </div>}
    {snapshot?.pending.map(attempt => <div key={attempt.id} className="mt-3 rounded border border-amber-400/40 p-3">
      <p className="font-medium text-amber-100">Approval required · {attempt.provider}/{attempt.model} · {attempt.category}</p>
      <p className="mt-1">Purpose: {attempt.reason || attempt.category}. Paused: {attempt.pauseReason || 'Approval required.'}</p>
      <p className="mt-1">Requested model: {attempt.model} · resolved model: {attempt.resolvedModel || 'not yet known'}.</p>
      <p className="mt-1">Preflight estimate {dollars(attempt.reservedMicrousd)}. This estimate is not a guaranteed spending ceiling.</p>
      <p className="mt-1">{attempt.provider === 'runpod' ? <>Fixed reviewed infrastructure reservation {dollars(attempt.reservedMicrousd)}. Exact actual cost requires an authoritative execution receipt.</> : <>Payload: {attempt.preview.textBytes.toLocaleString()} text bytes · {attempt.preview.imageCount} images ({attempt.preview.imageBytes.toLocaleString()} inline bytes) · estimated input {attempt.preview.inputTokens.toLocaleString()} tokens, including image allowance {attempt.preview.imageTokens.toLocaleString()} · configured output allowance {attempt.preview.outputAllowance.toLocaleString()} tokens.</>}</p>
      <p className="mt-1">This original request already has estimated settled cost {dollars(attempt.requestExposure.estimatedCostMicrousd)}, pending {dollars(attempt.requestExposure.pendingExposureMicrousd)} (includes this proposal), uncertain {dollars(attempt.requestExposure.uncertainExposureMicrousd)}.{BigInt(attempt.requestExposure.estimatedInfrastructureMicrousd ?? '0') > 0n && <> <InfrastructureEstimate totals={attempt.requestExposure}/>.</>}{attempt.requestExposure.unknownCostCount > 0 && ' Some dispatched costs remain unknown.'}</p>
      <p className="mt-1">Thresholds: per call {snapshot.configuration?.per_call_limit_microusd == null ? 'unset' : dollars(snapshot.configuration.per_call_limit_microusd)} · original request {snapshot.configuration?.request_limit_microusd == null ? 'unset' : dollars(snapshot.configuration.request_limit_microusd)}.</p>
      <details className="mt-1"><summary className="cursor-pointer">Estimate assumptions & uncertainty</summary><ul className="mt-1 list-disc pl-4">{[...attempt.preview.assumptions, ...attempt.preview.issues].map((assumption, index) => <li key={index}>{assumption}</li>)}</ul></details>
      {attempt.tradeoffs && <p className="mt-1 text-amber-100">Reduction tradeoffs: {attempt.tradeoffs}</p>}
      <p className="mt-1 break-all text-zinc-400">Exact attempt {attempt.id} · pricing {attempt.pricingVersion} · estimator {attempt.estimatorVersion} · budget revision {attempt.budgetRevision}</p>
      <div className="mt-2 flex gap-4"><button type="button" disabled={Boolean(busy) || !configurationComplete} onClick={() => void decide(attempt, 'approve_once')} className="rounded bg-amber-100 px-3 py-1 text-zinc-950 disabled:opacity-50">Approve once</button>{attempt.provider === 'runpod' ? <span>Fixed reservation: use fewer images in a new request to reduce cost.</span> : <button type="button" disabled={Boolean(busy)} onClick={() => void decide(attempt, 'reduce_cost')} className="underline disabled:opacity-50">Reduce cost</button>}<button type="button" disabled={Boolean(busy)} onClick={() => void decide(attempt, 'cancel')} className="underline disabled:opacity-50">Cancel</button></div>
    </div>)}


    </section> : <p className="text-zinc-500">No active requests.</p>}
    <section className="space-y-2"><h3 className="text-sm font-semibold text-white">Alerts</h3>
    {snapshot?.alerts?.map((alert, index) => <p role="alert" key={`${alert.attemptId}:${alert.kind}:${index}`} className="mt-2 rounded border border-amber-400/40 p-2 text-amber-100"><strong>{alert.kind === 'overrun' ? 'Preflight overrun' : alert.kind === 'receipt_conflict' ? 'Receipt conflict' : 'Uncertain provider outcome'}</strong> · {alert.provider}/{alert.model} · {alert.message}{alert.actualMicrousd !== null && ` Settled ${dollars(alert.actualMicrousd)}; reserved ${dollars(alert.reservedMicrousd)}.`} <span className="break-all">Attempt {alert.attemptId}</span></p>)}


      {snapshot?.pending.length ? <p className="text-amber-200">{snapshot.pending.length} approval(s) required</p> : null}
      {!snapshot?.alerts?.length && !snapshot?.pending.length && <p className="text-zinc-500">No current alerts.</p>}
      {error && <p role="alert" className="text-amber-200">{error}</p>}
      {refreshError && <p role="alert" className="text-amber-200">{refreshError}{snapshot && " Previously loaded values may be stale."}</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
    {settingsOpen && <form onSubmit={event => void saveSettings(event)} className="mt-3 space-y-3 rounded border border-white/20 p-3">
      <p>Owner settings apply to all standalone agents. Per request includes main calls, retries, routing, summarization, memory and other hidden helpers. USD estimates are not provider invoices.</p>
      <label className="block">Timezone (IANA)<input required value={timezone} placeholder="e.g. America/New_York" onChange={event => setTimezone(event.target.value)} className="ml-2 rounded border border-white/20 bg-zinc-900 p-1" /></label>
      <label className="block">Per call approval threshold (USD)<input inputMode="decimal" required value={callLimit} onChange={event => setCallLimit(event.target.value)} className="ml-2 w-28 rounded border border-white/20 bg-zinc-900 p-1" /></label>
      <label className="block">Per request approval threshold (USD)<input inputMode="decimal" required value={requestLimit} onChange={event => setRequestLimit(event.target.value)} className="ml-2 w-28 rounded border border-white/20 bg-zinc-900 p-1" /></label>
      <p>Zero requires approval for every positive estimate. No timezone or monetary thresholds are preselected.</p>
      <div className="flex gap-4"><button disabled={Boolean(busy)} className="rounded border border-white/30 px-3 py-1">Save settings</button><button type="button" onClick={() => setSettingsOpen(false)} className="underline">Close</button></div>
    </form>}


  </section>;
  return <section aria-label="Standalone daily usage" className="relative z-20 shrink-0 min-w-0 border-b border-white/10 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-300 sm:px-5">
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <span className="min-w-0 truncate" aria-live="polite">
        {daily ? <>Today {displayedCost(daily.totals)}{BigInt(daily.totals.estimatedInfrastructureMicrousd ?? '0') > 0n && ' including infrastructure estimate'} · Pending {dollars(daily.totals.pendingExposureMicrousd)} · <Tokens totals={daily.totals} /></> : (error || refreshError) ? 'Usage unavailable' : 'Loading usage…'}
      </span>
      <button type="button" aria-expanded={usageOpen} aria-controls="standalone-usage-details" className="shrink-0 underline underline-offset-2" onClick={() => { setUsageOpen(v => !v); setReviewOpen(false); }}>Usage details</button>
      {(approvals > 0 || unresolved > 0 || alerts > 0) && <span className="flex min-w-0 flex-wrap items-center gap-2 text-amber-200" role="status">
        {approvals > 0 ? `${approvals} approval${approvals === 1 ? '' : 's'} required` : `${unresolved} active/reserved`}
        {alerts > 0 && ` · ${alerts} alerts`}
        <button type="button" aria-expanded={reviewOpen} aria-controls="standalone-attempt-review" className="underline underline-offset-2" onClick={() => { setReviewOpen(v => !v); setUsageOpen(false); }}>Review</button>
      </span>}
      {snapshot && !configurationComplete && <button type="button" className="text-amber-200 underline" onClick={openSettings}>Set budget settings</button>}
    </div>
    {error && <p role="alert" className="text-amber-200">{error}</p>}
    {refreshError && <p role="alert" className="text-amber-200">{refreshError}{snapshot && ' Previously loaded values may be stale.'}</p>}
    {notice && <p role="status" className="truncate">{notice}</p>}
    {usageOpen && <div id="standalone-usage-details" className="absolute left-0 right-0 top-full z-30 max-h-[65vh] overflow-y-auto overscroll-contain border border-white/20 bg-zinc-950 p-3 shadow-xl sm:p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <strong className="text-zinc-100">Daily standalone usage</strong>
        <button type="button" className="underline" onClick={() => setUsageOpen(false)}>Close details</button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label>Scope <select className="ml-1 rounded border border-white/20 bg-zinc-900 p-1" value={scope} onChange={event => setScope(event.target.value as typeof scope)}><option value="this-agent">This agent</option><option value="all">All standalone</option></select></label>
        <button type="button" onClick={openSettings} className="underline">Budget & timezone</button>
        <button type="button" onClick={() => void refresh()} className="underline">Refresh</button>
      </div>
      {snapshot && !configurationComplete && <p className="mt-2 text-amber-200">Configuration required: choose a timezone and explicitly set both approval thresholds before paid standalone calls.</p>}
    {daily && <>
      <p className="mt-2">{daily.date} · {daily.timezone} · Estimated cost {displayedCost(daily.totals)} · Pending {dollars(daily.totals.pendingExposureMicrousd)} · Uncertain {dollars(daily.totals.uncertainExposureMicrousd)}</p>
      <p className="mt-1"><InfrastructureEstimate totals={daily.totals}/></p>
      <p className="mt-1"><Tokens totals={daily.totals} />{daily.totals.unknownCostCount > 0 && ` · ${daily.totals.unknownCostCount} call(s) with unknown cost; displayed cost is incomplete.`}</p>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1">{daily.providers.map(provider => <p key={provider.provider}><ProviderUsage provider={provider}/></p>)}</div>
      {daily.unresolvedEarlier.attemptCount > 0 && <p className="mt-2 rounded border border-amber-400/30 p-2 text-amber-200">Earlier unresolved exposure ({daily.unresolvedEarlier.attemptCount} attempts): pending {dollars(daily.unresolvedEarlier.pendingExposureMicrousd)} · uncertain {dollars(daily.unresolvedEarlier.uncertainExposureMicrousd)}. Kept separate from today; still reserved on the original requests.</p>}
      <details className="mt-2"><summary className="cursor-pointer">Models & activity, including hidden helpers ({daily.totals.attemptCount} attempts)</summary>
        <div className="mt-2 overflow-x-auto"><table className="w-full text-left"><thead><tr><th className="pr-4">Provider / model</th><th className="pr-4">Activity</th><th className="pr-4">Tokens</th><th>Estimated cost</th></tr></thead><tbody>{daily.models.map(model => <tr key={JSON.stringify([model.provider, model.model, model.category])}><td className="py-1 pr-4">{model.provider} / {model.model}</td><td className="pr-4">{model.category}</td><td className="pr-4"><>{model.provider === 'runpod' ? 'Infrastructure billing' : <Tokens totals={model}/>}</></td><td><ModelCost model={model}/></td></tr>)}</tbody></table></div>
        <ul className="mt-2 space-y-1">{daily.attempts.map(attempt => <li key={attempt.id}>{new Intl.DateTimeFormat(undefined, { timeZone: daily.timezone, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(attempt.dispatched_at || attempt.created_at))} · {attempt.provider}/{attempt.model} · {attempt.category} · {attempt.state} · {attempt.actual_microusd === null ? (attempt.provider === 'runpod' && attempt.state === 'estimated' ? `estimated infrastructure cost ${dollars(attempt.reserved_microusd)} · actual cost unconfirmed` : 'cost unknown / not settled') : dollars(attempt.actual_microusd)}</li>)}</ul>
      </details>
    </>}

    {settingsOpen && <form onSubmit={event => void saveSettings(event)} className="mt-3 space-y-3 rounded border border-white/20 p-3">
      <p>Owner settings apply to all standalone agents. Per request includes main calls, retries, routing, summarization, memory and other hidden helpers. USD estimates are not provider invoices.</p>
      <label className="block">Timezone (IANA)<input required value={timezone} placeholder="e.g. America/New_York" onChange={event => setTimezone(event.target.value)} className="ml-2 rounded border border-white/20 bg-zinc-900 p-1" /></label>
      <label className="block">Per call approval threshold (USD)<input inputMode="decimal" required value={callLimit} onChange={event => setCallLimit(event.target.value)} className="ml-2 w-28 rounded border border-white/20 bg-zinc-900 p-1" /></label>
      <label className="block">Per request approval threshold (USD)<input inputMode="decimal" required value={requestLimit} onChange={event => setRequestLimit(event.target.value)} className="ml-2 w-28 rounded border border-white/20 bg-zinc-900 p-1" /></label>
      <p>Zero requires approval for every positive estimate. No timezone or monetary thresholds are preselected.</p>
      <div className="flex gap-4"><button disabled={Boolean(busy)} className="rounded border border-white/30 px-3 py-1">Save settings</button><button type="button" onClick={() => setSettingsOpen(false)} className="underline">Close</button></div>
    </form>}

    </div>}
    {reviewOpen && <div id="standalone-attempt-review" className="absolute left-0 right-0 top-full z-30 max-h-[65vh] overflow-y-auto overscroll-contain border border-amber-400/30 bg-zinc-950 p-3 shadow-xl sm:p-4">
      <div className="flex items-center justify-between gap-2">
        <strong className="text-amber-100">Requests and approvals</strong>
        <button type="button" onClick={() => setReviewOpen(false)} className="underline">Close review</button>
      </div>
    {snapshot?.alerts?.map((alert, index) => <p role="alert" key={`${alert.attemptId}:${alert.kind}:${index}`} className="mt-2 rounded border border-amber-400/40 p-2 text-amber-100"><strong>{alert.kind === 'overrun' ? 'Preflight overrun' : alert.kind === 'receipt_conflict' ? 'Receipt conflict' : 'Uncertain provider outcome'}</strong> · {alert.provider}/{alert.model} · {alert.message}{alert.actualMicrousd !== null && ` Settled ${dollars(alert.actualMicrousd)}; reserved ${dollars(alert.reservedMicrousd)}.`} <span className="break-all">Attempt {alert.attemptId}</span></p>)}

    {activeAttempts.length > 0 && <div aria-label="Active attempts in this conversation" className="mt-2 space-y-2">
      <p className="font-medium text-zinc-100">Active or unresolved attempts in this conversation</p>
      {activeAttempts.map(attempt => <div key={attempt.id} className="rounded border border-white/20 p-2">
        <p>{attempt.provider}/{attempt.model} · {attempt.category} · {attempt.state} · exposure {dollars(attempt.reservedMicrousd)}</p>
        <p className="mt-1 break-all text-zinc-400">Exact attempt {attempt.id} · original request {attempt.requestId}</p>
        {attempt.continuationActionable !== true && <p role="status" className="mt-1 text-amber-100">{attempt.state === 'uncertain' ? 'Uncertain exposure retained' : 'Exposure retained'} · parent request {attempt.parentStatus === 'completed' ? 'already completed' : attempt.parentStatus === 'running' ? 'already running' : attempt.parentStatus ?? 'not resumable'}</p>}
        {attempt.continuationBlockedReason && <p role="alert" className="mt-1 text-amber-200">{attempt.continuationBlockedReason} This technical limitation cannot be changed by continuing the same request.</p>}
        {(attempt.state === 'reserved' || attempt.pollableRunpod) && attempt.continuationActionable === true && !attempt.continuationBlockedReason && <button type="button" disabled={Boolean(busy)} onClick={() => void resumeReserved(attempt)} className="mr-4 mt-1 rounded border border-white/30 px-2 py-1 disabled:opacity-50">{attempt.pollableRunpod ? 'Check saved Qwen analysis' : 'Resume saved work'}</button>}
        {attempt.state === 'uncertain' && attempt.continuationActionable === true && <>
          <p className="mt-1">The provider call was already sent, but exact usage/cost could not be confirmed. Continuing will retain the full reserved exposure and will not resend this attempt.</p>
          {attempt.exposureAccepted && <p className="mt-1 text-amber-100">Uncertain exposure accepted · {dollars(attempt.reservedMicrousd)} retained</p>}
          {!attempt.continuationBlockedReason && !attempt.pollableRunpod && <button type="button" disabled={Boolean(busy) || !configurationComplete} onClick={() => void acceptExposure(attempt)} className="mr-4 mt-1 rounded border border-amber-300/50 px-2 py-1 disabled:opacity-50">{attempt.exposureAccepted ? 'Continue remaining work' : 'Accept exposure & continue'}</button>}
        </>}
        {attempt.pollableRunpod && <p className="mt-1">Qwen image analysis was already submitted. Checking the saved analysis polls that existing job and will not submit another image analysis.</p>}
        {attempt.state === 'dispatched' && !attempt.pollableRunpod && <p className="mt-1">Already dispatched. Cancellation stops remaining work where possible; spending exposure stays held until provider usage is reconciled.</p>}
        {attempt.continuationActionable === true && <button type="button" disabled={Boolean(busy)} onClick={() => void decide(attempt, 'cancel')} className="mt-1 underline disabled:opacity-50">Cancel remaining work</button>}
      </div>)}
    </div>}
    {snapshot?.pending.map(attempt => <div key={attempt.id} className="mt-3 rounded border border-amber-400/40 p-3">
      <p className="font-medium text-amber-100">Approval required · {attempt.provider}/{attempt.model} · {attempt.category}</p>
      <p className="mt-1">Purpose: {attempt.reason || attempt.category}. Paused: {attempt.pauseReason || 'Approval required.'}</p>
      <p className="mt-1">Requested model: {attempt.model} · resolved model: {attempt.resolvedModel || 'not yet known'}.</p>
      <p className="mt-1">Preflight estimate {dollars(attempt.reservedMicrousd)}. This estimate is not a guaranteed spending ceiling.</p>
      <p className="mt-1">{attempt.provider === 'runpod' ? <>Fixed reviewed infrastructure reservation {dollars(attempt.reservedMicrousd)}. Exact actual cost requires an authoritative execution receipt.</> : <>Payload: {attempt.preview.textBytes.toLocaleString()} text bytes · {attempt.preview.imageCount} images ({attempt.preview.imageBytes.toLocaleString()} inline bytes) · estimated input {attempt.preview.inputTokens.toLocaleString()} tokens, including image allowance {attempt.preview.imageTokens.toLocaleString()} · configured output allowance {attempt.preview.outputAllowance.toLocaleString()} tokens.</>}</p>
      <p className="mt-1">This original request already has estimated settled cost {dollars(attempt.requestExposure.estimatedCostMicrousd)}, pending {dollars(attempt.requestExposure.pendingExposureMicrousd)} (includes this proposal), uncertain {dollars(attempt.requestExposure.uncertainExposureMicrousd)}.{BigInt(attempt.requestExposure.estimatedInfrastructureMicrousd ?? '0') > 0n && <> <InfrastructureEstimate totals={attempt.requestExposure}/>.</>}{attempt.requestExposure.unknownCostCount > 0 && ' Some dispatched costs remain unknown.'}</p>
      <p className="mt-1">Thresholds: per call {snapshot.configuration?.per_call_limit_microusd == null ? 'unset' : dollars(snapshot.configuration.per_call_limit_microusd)} · original request {snapshot.configuration?.request_limit_microusd == null ? 'unset' : dollars(snapshot.configuration.request_limit_microusd)}.</p>
      <details className="mt-1"><summary className="cursor-pointer">Estimate assumptions & uncertainty</summary><ul className="mt-1 list-disc pl-4">{[...attempt.preview.assumptions, ...attempt.preview.issues].map((assumption, index) => <li key={index}>{assumption}</li>)}</ul></details>
      {attempt.tradeoffs && <p className="mt-1 text-amber-100">Reduction tradeoffs: {attempt.tradeoffs}</p>}
      <p className="mt-1 break-all text-zinc-400">Exact attempt {attempt.id} · pricing {attempt.pricingVersion} · estimator {attempt.estimatorVersion} · budget revision {attempt.budgetRevision}</p>
      <div className="mt-2 flex gap-4"><button type="button" disabled={Boolean(busy) || !configurationComplete} onClick={() => void decide(attempt, 'approve_once')} className="rounded bg-amber-100 px-3 py-1 text-zinc-950 disabled:opacity-50">Approve once</button>{attempt.provider === 'runpod' ? <span>Fixed reservation: use fewer images in a new request to reduce cost.</span> : <button type="button" disabled={Boolean(busy)} onClick={() => void decide(attempt, 'reduce_cost')} className="underline disabled:opacity-50">Reduce cost</button>}<button type="button" disabled={Boolean(busy)} onClick={() => void decide(attempt, 'cancel')} className="underline disabled:opacity-50">Cancel</button></div>
    </div>)}

    </div>}
  </section>;
}
