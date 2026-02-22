import { put, list } from '@vercel/blob';

// --- ACTOR LOGIC ---

export async function createActor(name: string, systemPurpose: string) {
  const actorId = crypto.randomUUID();
  const actorData = { id: actorId, name, systemPurpose, createdAt: new Date() };

  // Store as a private JSON file
  await put(`actors/${actorId}.json`, JSON.stringify(actorData), {
    access: 'private' as any,
    addRandomSuffix: false, // Keep the URL predictable
    contentType: 'application/json',
  });
  return actorData;
}

export async function getAllActors() {
  const { blobs } = await list({ prefix: 'actors/' });
  // We'll need to fetch the content of each blob to get the names/IDs
  return Promise.all(blobs.map(async (b) => {
    const res = await fetch(b.url, {
      headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
    });
    return res.json();
  }));
}

// --- CHAT LOGIC ---

export async function saveChat(actorId: string, chatId: string, chatState: any) {
  return await put(`chats/${actorId}/${chatId}.json`, JSON.stringify(chatState), {
    access: 'private' as any,
    addRandomSuffix: false,
    contentType: 'application/json',
  });
}
