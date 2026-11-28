"use client";

import {useRef, useState} from 'react';
import {ownerSessionBearer} from '@/lib/tools/browser-owner-session';
import {projectBudgetMicrousd, type OrganizationApproval} from '@/lib/projects/organization-approval';

export function ProjectOrganizationApproval({offer, disabled = false, onRefresh}: {
  offer: OrganizationApproval; disabled?: boolean; onRefresh: () => void;
}) {
  // A changed objective, deadline or limit requires a fresh, unchecked form.
  return <ApprovalForm key={JSON.stringify(offer)} offer={offer} disabled={disabled} onRefresh={onRefresh}/>;
}

function ApprovalForm({offer, disabled, onRefresh}: {
  offer: OrganizationApproval; disabled: boolean; onRefresh: () => void;
}) {
  const [total, setTotal] = useState(''), [perCall, setPerCall] = useState('');
  const [consent, setConsent] = useState(false), [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null), [authorized, setAuthorized] = useState(false);
  const submitting = useRef(false);
  const ceilingMicrousd = projectBudgetMicrousd(total), perCallMicrousd = projectBudgetMicrousd(perCall);
  const valid = ceilingMicrousd !== null && perCallMicrousd !== null && perCallMicrousd <= ceilingMicrousd;
  const expired = Date.now() >= Date.parse(offer.deadline);

  async function authorize() {
    if (!valid || !consent || disabled || pending || authorized || submitting.current || Date.now() >= Date.parse(offer.deadline)) return;
    submitting.current = true; setPending(true); setError(null);
    try {
      const bearer = await ownerSessionBearer();
      if (!bearer) throw Error('Sign in as the project owner to approve.');
      const {projectId, objectiveHash, ...terms} = offer;
      const response = await fetch('/api/projects/organization', {
        method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + bearer},
        body: JSON.stringify({projectId, objectiveHash, terms, autonomousExecution: true, ceilingMicrousd, perCallMicrousd}),
      });
      const result = await response.json();
      if (!response.ok) throw Error(typeof result.error === 'string' ? result.error : 'Project approval could not be confirmed.');
      if (result.authorized !== true) throw Error('Project approval could not be confirmed. Refresh project status.');
      setAuthorized(true); onRefresh();
    } catch (e) {
      setConsent(false);
      setError(e instanceof Error ? e.message : 'Project approval could not be confirmed.');
    } finally {setPending(false); submitting.current = false;}
  }

  return <aside aria-label="Project budget approval" className="mx-3 my-2 rounded-xl border border-amber-300/60 bg-amber-950/70 p-4 text-amber-50">
    <h3 className="font-semibold">Authorize this project</h3>
    <p className="mt-2 whitespace-pre-wrap text-sm">{offer.objective}</p>
    {offer.clarifications && <p className="mt-2 whitespace-pre-wrap text-sm">{offer.clarifications}</p>}
    <p className="mt-2 text-sm">Repository: {offer.repository ?? 'Not selected yet'}</p>
    <p className="mt-2 text-sm">Limits: {offer.limits.missions.toLocaleString()} missions, {offer.limits.codingJobs.toLocaleString()} coding jobs and {offer.limits.modelTokens.toLocaleString()} model tokens. Deadline: {new Date(offer.deadline).toISOString()} (UTC).</p>
    <p className="mt-2 text-sm">This authorizes paid planning and, after you approve the exact coding scope, delegated coding and review. You will review the requirements, file paths and acceptance tests before coding starts.</p>
    {authorized ? <p className="mt-3 text-sm" role="status">Project authorization recorded.</p> : <div className="mt-3 space-y-3">
      <label className="block text-sm">Total project budget (USD)
        <input type="text" inputMode="decimal" autoComplete="off" value={total} disabled={disabled || pending}
          onChange={e => {setTotal(e.target.value); setConsent(false);}}
          className="mt-1 block min-h-11 w-full rounded border border-white/30 bg-black/30 px-3 text-white"/>
      </label>
      <label className="block text-sm">Maximum per model call (USD)
        <input type="text" inputMode="decimal" autoComplete="off" value={perCall} disabled={disabled || pending}
          onChange={e => {setPerCall(e.target.value); setConsent(false);}}
          className="mt-1 block min-h-11 w-full rounded border border-white/30 bg-black/30 px-3 text-white"/>
      </label>
      <p className="text-xs">Enter your own limits, up to $1,000 total. The per-call limit cannot exceed the total. Up to six decimal places are supported. These limits control approved model usage; they are not a quote for the final provider bill.</p>
      <label className="block text-sm"><input type="checkbox" checked={consent} disabled={disabled || pending || !valid || expired}
        onChange={e => setConsent(e.target.checked)}/> I authorize autonomous paid work for this objective within the budget, project limits and deadline shown above, with coding subject to my separate scope approval.</label>
      <button type="button" onClick={() => void authorize()} disabled={disabled || pending || !valid || !consent || expired}
        className="min-h-11 rounded-xl bg-emerald-400 px-4 py-2 text-sm font-bold text-zinc-950 disabled:opacity-50">
        {pending ? 'Recording approval…' : 'Authorize project'}
      </button>
      {expired && <p role="status" className="text-sm">The project deadline has passed. Refresh project status.</p>}
    </div>}
    {error && <p role="alert" className="mt-2 text-sm text-red-200">{error}</p>}
  </aside>;
}
