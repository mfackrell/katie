import { put } from '@vercel/blob';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get('file');

  if (!(file instanceof File)) {
    return Response.json({ error: 'Missing file field' }, { status: 400 });
  }

  if (!file.type.startsWith('image/')) {
    return Response.json({ error: 'Only image uploads are supported' }, { status: 400 });
  }

  const extension = file.name.includes('.') ? file.name.split('.').pop() : 'png';
  const pathname = `actors/${crypto.randomUUID()}.${extension}`;

  const blob = await put(pathname, file, {
    access: 'public',
    addRandomSuffix: false
  });

  return Response.json({ url: blob.url });
}
