'use client';

import { createActorAction } from '../app/actions/actors';

export default function NewActorModal() {
  return (
    <div className="p-6 bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl w-full max-w-md">
      <h2 className="text-xl font-bold mb-4">Create New Actor</h2>
      <form action={createActorAction} className="space-y-4">
        <div>
          <label className="block text-xs font-bold text-zinc-500 uppercase mb-1">Actor Name</label>
          <input
            name="name"
            placeholder="e.g. Expert Web Designer"
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg p-2 text-sm focus:outline-none focus:border-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs font-bold text-zinc-500 uppercase mb-1">Permanent Purpose (System Prompt)</label>
          <textarea
            name="systemPurpose"
            rows={4}
            placeholder="Describe exactly how this AI should behave..."
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg p-2 text-sm focus:outline-none focus:border-blue-500"
          />
        </div>
        <button type="submit" className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-2 rounded-lg transition-colors">
          Initialize Actor
        </button>
      </form>
    </div>
  );
}
