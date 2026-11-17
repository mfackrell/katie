'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ownerSessionBearer } from '@/lib/tools/browser-owner-session';
import { isRoutingMode, type RoutingMode, type RoutingPreferences } from '@/lib/routing-preferences/types';

export function useRoutingPreferences(actorId: string, chatId: string) {
  const key = `${actorId}:${chatId}`;
  const activeKey = useRef(key); activeKey.current = key;
  const [state, setState] = useState<{key: string; value: RoutingPreferences} | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const request = useCallback(async (change?: {target: 'global' | 'conversation'; mode: RoutingMode | null}) => {
    const ticket = ++sequence.current;
    setPending(true); setError('');
    try {
      const bearer = await ownerSessionBearer();
      const response = await fetch(`/api/routing-preferences?${new URLSearchParams({actorId, chatId})}`, {
        method: change ? 'PATCH' : 'GET', cache: 'no-store',
        headers: {'Content-Type': 'application/json', ...(bearer ? {Authorization: `Bearer ${bearer}`} : {})},
        ...(change ? {body: JSON.stringify({actorId, chatId, ...change})} : {}),
      });
      if (!response.ok) throw Error('Routing preferences unavailable. Sign in or retry.');
      const value = await response.json() as RoutingPreferences;
      if (!isRoutingMode(value.global) || !isRoutingMode(value.effective) || (value.conversation !== null && !isRoutingMode(value.conversation))) throw Error('Invalid routing preferences.');
      if (activeKey.current === key && ticket === sequence.current) setState({key, value});
    } catch (failure) {
      if (activeKey.current === key && ticket === sequence.current) setError(failure instanceof Error ? failure.message : 'Preference save failed.');
    } finally {
      if (activeKey.current === key && ticket === sequence.current) setPending(false);
    }
  }, [actorId, chatId, key]);
  useEffect(() => { setState(null); void request(); }, [request]);
  const value = state?.key === key ? state.value : null;
  return {value, pending, error, save: request};
}

export function RoutingPreferenceControls({preferences}: {preferences: ReturnType<typeof useRoutingPreferences>}) {
  const {value, pending, error, save} = preferences;
  const [target, setTarget] = useState<'global' | 'conversation'>('conversation');
  const mode = target === 'global' ? value?.global : value?.effective;
  return <fieldset className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-white/10 px-2 py-1 text-xs text-zinc-300">
    <legend className="px-1">Automatic routing</legend>
    <label>Apply to <select aria-label="Routing preference scope" value={target} onChange={e => setTarget(e.target.value as typeof target)} className="max-w-full bg-zinc-950 p-1">
      <option value="conversation">This conversation</option><option value="global">Default for all conversations</option>
    </select></label>
    <label>Preference <select aria-label="Routing preference" disabled={pending || !value} value={mode ?? 'best_value'} onChange={e => {if (isRoutingMode(e.target.value)) void save({target, mode: e.target.value});}} className="bg-zinc-950 p-1">
      <option value="best_answer">Best Answer</option><option value="best_value">Best Value</option>
    </select></label>
    {target === 'conversation' && value?.conversation !== null && value && <button type="button" disabled={pending} onClick={() => void save({target: 'conversation', mode: null})}>Use global default</button>}
    <span role="status">{pending ? 'Saving or loading…' : value ? value.conversation === null ? 'Using global default. Manual model selection takes priority.' : 'Conversation override saved. Manual model selection takes priority.' : ''}</span>
    {error && <span role="alert">{error} <button type="button" disabled={pending} onClick={() => void save()}>Reload preferences</button></span>}
  </fieldset>;
}
