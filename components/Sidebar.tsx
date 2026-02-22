// components/Sidebar.tsx
import { list } from '@vercel/blob';
import ModelDiscovery from './ModelDiscovery';

export default async function Sidebar() {
  const { blobs: actorBlobs } = await list({ prefix: 'actors/', access: 'private' });
  const actors = await Promise.all(actorBlobs.map(async (b) => (await fetch(b.url)).json()));

  const actorSections = await Promise.all(
    actors.map(async (actor) => {
      const { blobs: chatBlobs } = await list({
        prefix: `chats/${actor.id}/`,
        access: 'private',
      });
      const chats = await Promise.all(chatBlobs.map(async (b) => (await fetch(b.url)).json()));

      return {
        actor,
        chats,
      };
    }),
  );

  return (
    <aside className="w-72 bg-zinc-950 flex flex-col border-r border-zinc-800">
      <nav className="flex-1 overflow-y-auto px-2 space-y-4 pt-4">
        {actorSections.map(({ actor, chats }) => (
          <div key={actor.id}>
            <div className="text-xs font-bold text-zinc-500 uppercase px-2 mb-1">
              {actor.name}
            </div>
            <div className="space-y-1">
              {chats.map((chat) => (
                <a key={chat.id} href={`/chat/${chat.id}`} className="block px-3 py-2 text-sm rounded-md hover:bg-zinc-900 text-zinc-400 truncate">
                  {chat.title}
                </a>
              ))}
            </div>
          </div>
        ))}

        <ModelDiscovery />
      </nav>
    </aside>
  );
}
