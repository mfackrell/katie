import { list, put } from '@vercel/blob';

type Actor = {
  id: string;
  name: string;
  systemPurpose: string;
  createdAt: string;
};

type ChatState = {
  id: string;
  actorId: string;
  title: string;
  intermediarySummary: string;
  history: Array<{ role: string; content: string }>;
  createdAt: string;
};

function blobAuthHeaders() {
  return {
    Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`,
  };
}

export async function createActor(name: string, systemPurpose: string): Promise<Actor> {
  const actorId = crypto.randomUUID();
  const actorData: Actor = {
    id: actorId,
    name,
    systemPurpose,
    createdAt: new Date().toISOString(),
  };

  await put(`actors/${actorId}.json`, JSON.stringify(actorData), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
  });

  return actorData;
}

export async function getAllActors(): Promise<Actor[]> {
  const { blobs } = await list({ prefix: 'actors/' });
  return Promise.all(
    blobs.map(async (blob) => {
      const response = await fetch(blob.url, { headers: blobAuthHeaders() });
      return response.json() as Promise<Actor>;
    }),
  );
}

export async function saveChat(actorId: string, chatId: string, chatState: ChatState) {
  return put(`chats/${actorId}/${chatId}.json`, JSON.stringify(chatState), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
  });
}
