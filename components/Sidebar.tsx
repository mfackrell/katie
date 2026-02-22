import { list } from '@vercel/blob';
import Link from 'next/link';

export default async function Sidebar() {
  // 1. Fetch all Actor blobs
  const { blobs: actorBlobs } = await list({ prefix: 'actors/', access: 'public' });

  // 2. Fetch the actual content for each actor (parallelized for speed)
  const actors = await Promise.all(
    actorBlobs.map(async (blob) => {
      const response = await fetch(blob.url);
      return response.json();
    })
  );

  return (
    <aside className="w-72 bg-zinc-950 flex flex-col border-r border-zinc-800">
      <div className="p-4">
        {/* Trigger for the New Actor Modal we created earlier */}
        <button className="w-full py-2 bg-zinc-800 rounded-lg text-sm font-medium">
          + New Actor
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2">
        {actors.map((actor) => (
          <div key={actor.id} className="mb-4">
            <div className="flex items-center text-xs font-bold text-zinc-500 uppercase p-2">
               <span>{actor.name}</span>
            </div>
            {/* 3. Sub-chats will be fetched here in the next step */}
            <div className="space-y-1 ml-2">
               <p className="text-[10px] text-zinc-600 italic px-2">No active chats...</p>
            </div>
          </div>
        ))}
      </nav>
    </aside>
  );
}
