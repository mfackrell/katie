import { list } from '@vercel/blob';
import CreateActorTrigger from './CreateActorTrigger';
import CreateChatTrigger from './CreateChatTrigger';
import ModelDiscovery from './ModelDiscovery';

function blobAuthHeaders() {
  return {
    Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`,
  };
}

export default async function Sidebar() {
  const { blobs: actorBlobs } = await list({ prefix: 'actors/' });

  const actors = await Promise.all(
    actorBlobs.map(async (blob) => {
      const response = await fetch(blob.url, { headers: blobAuthHeaders() });
      return response.json();
    }),
  );

  const actorSections = await Promise.all(
    actors.map(async (actor) => {
      const { blobs: chatBlobs } = await list({ prefix: `chats/${actor.id}/` });
      const chats = await Promise.all(
        chatBlobs.map(async (blob) => {
          const response = await fetch(blob.url, { headers: blobAuthHeaders() });
          return response.json();
        }),
      );

      return { actor, chats };
    }),
  );

  return (
    <aside className="w-72 bg-zinc-950 flex flex-col border-r border-zinc-800">
      <CreateActorTrigger />
      <nav className="flex-1 overflow-y-auto px-2 space-y-4">
        {actorSections.map(({ actor, chats }) => (
          <div key={actor.id}>
            <div className="text-xs font-bold text-zinc-500 uppercase px-2 mb-1">{actor.name}</div>
            <div className="space-y-1">
              {chats.map((chat) => (
                <a
                  key={chat.id}
                  href={`/chat/${actor.id}/${chat.id}`}
                  className="block px-3 py-2 text-sm rounded-md hover:bg-zinc-900 text-zinc-400 truncate"
                >
                  {chat.title}
                </a>
              ))}
              <CreateChatTrigger actorId={actor.id} />
            </div>
          </div>
        ))}

        <ModelDiscovery />
      </nav>
    </aside>
  );
}
