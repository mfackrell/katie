'use client';

import { useEffect, useState } from 'react';

type DiscoveredModel = {
  id: string;
  provider: string;
};

export default function ModelDiscovery() {
  const [models, setModels] = useState<DiscoveredModel[]>([]);

  useEffect(() => {
    fetch('/api/models')
      .then((res) => res.json())
      .then((data) => setModels(Array.isArray(data) ? data : []))
      .catch((err) => console.error(err));
  }, []);

  return (
    <div className="p-4 bg-zinc-900/50 border border-zinc-800 rounded-lg mt-4">
      <h3 className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
        Available Intelligence
      </h3>
      <div className="space-y-1">
        {models.length > 0 ? models.slice(0, 5).map((model) => (
          <div key={`${model.provider}-${model.id}`} className="flex justify-between items-center text-[10px] gap-2">
            <span className="text-zinc-300 truncate w-32">{model.id}</span>
            <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500 border border-zinc-700">
              {model.provider}
            </span>
          </div>
        )) : (
          <div className="animate-pulse text-[10px] text-zinc-600">Syncing with Providers...</div>
        )}
      </div>
    </div>
  );
}
