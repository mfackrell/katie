import { list } from '@vercel/blob';
import ModelDiscovery from './ModelDiscovery';

export default async function Sidebar() {
  const headers = { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` };

  // list() does not accept an 'access' property; permissions are managed by the token.
  const { blobs: actorBlobs } = await list({ prefix: 'actors/' });

  const actors = await Promise.all(
    actorBlobs.map(async (b) => {
      const res = await fetch(b.url, { headers });
      return res.json();
    })
  );

  const actorSections = await Promise.all(
    actors.map(async (actor) => {
      const { blobs: chatBlobs } = await list({
        prefix: `chats/${actor.id}/`,
      });
      const chats = await Promise.all(
        chatBlobs.map(async (b) => {
          const res = await fetch(b.url, { headers });
          return res.json();
        })
      );

      return { actor, chats };
    })
  );

  return (
    <aside className="w-72 bg-zinc-950 flex flex-col border-r border-zinc-800">
      <div className="p-4">
        <button className="w-full flex items-center justify-center gap-2 py-2 px-4 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg transition-all text-sm font-medium">
          <i className="fa-solid fa-plus text-xs"></i> New Actor
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 space-y-4 pt-4">
        {actorSections.map(({ actor, chats }) => (
          <div key={actor.id}>
            <div className="text-xs font-bold text-zinc-500 uppercase px-2 mb-1">
              {actor.name}
            </div>
            <div className="space-y-1">
              {chats.map((chat) => (
                <a key={chat.id} href={`/chat/${chat.id}`} className="block px-3 py-2 text-sm rounded-md hover:bg-zinc-900 text-zinc-400 truncate transition-colors">
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
