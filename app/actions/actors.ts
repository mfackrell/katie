'use server';

import { put } from '@vercel/blob';
import { revalidatePath } from 'next/cache';

export async function createActorAction(formData: FormData) {
  const name = formData.get('name') as string;
  const systemPurpose = formData.get('systemPurpose') as string;

  if (!name || !systemPurpose) return { error: "Missing fields" };

  const actorId = crypto.randomUUID();
  const actorData = {
    id: actorId,
    name,
    systemPurpose,
    createdAt: new Date().toISOString(),
  };

  try {
    // We store the file as actors/[id].json
    await put(`actors/${actorId}.json`, JSON.stringify(actorData), {
      access: 'private',
      addRandomSuffix: false,
      contentType: 'application/json',
    });

    // This refreshes the sidebar so the new Actor appears immediately
    revalidatePath('/');
    return { success: true };
  } catch (error) {
    console.error("Blob Upload Error:", error);
    return { error: "Failed to create actor" };
  }
}
