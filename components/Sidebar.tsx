// components/Sidebar.tsx
import { list } from '@vercel/blob';
import ModelDiscovery from './ModelDiscovery';
import CreateActorTrigger from './CreateActorTrigger';

export default async function Sidebar() {
  const headers = { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` };

  // Fetch all Actor blobs from private storage
  const { blobs: actorBlobs } = await list({ prefix: 'actors/' });
  
  const actors = await Promise.all(actorBlobs.map(async (b) => {
    // Authenticated fetch for private blob content
    const res = await fetch(b.url, { headers });
    return res.json();
  }));

  const actorSections = await Promise.all(
    actors.map(async (actor) => {
      // Fetch nested chats for each specific actor
      const { blobs: chatBlobs } = await list({ prefix: `chats/${actor.id}/` });
      const chats = await Promise.all(chatBlobs.map(async (b) => {
        const res = await fetch(b.url, { headers });
        return res.json();
      }));
      return { actor, chats };
    }),
  );

  return (
    <aside className="w-72 bg-zinc-950 flex flex-col border-r border-zinc-800">
      {/* 1. The Trigger to open the New Actor Modal */}
      <div className="p-4">
        <CreateActorTrigger />
      </div>

      <nav className="flex-1 overflow-y-auto px-2 space-y-4 pt-4">
        {/* 2. Map through Actor sections and their nested chats */}
        {actorSections.map(({ actor, chats }) => (
          <div key={actor.id}>
            <div className="text-xs font-bold text-zinc-500 uppercase px-2 mb-1">
              {actor.name}
            </div>
            <div className="space-y-1">
              {chats.map((chat) => (
                <a 
                  key={chat.id} 
                  href={`/chat/${chat.id}`} 
                  className="block px-3 py-2 text-sm rounded-md hover:bg-zinc-900 text-zinc-400 truncate transition-colors"
                >
                  {chat.title}
                </a>
              ))}
            </div>
          </div>
        ))}
        
        {/* 3. Real-time Model Availability */}
        <ModelDiscovery />
      </nav>
    </aside>
  );
}
