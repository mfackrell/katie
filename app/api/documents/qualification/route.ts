import { z } from 'zod';
import { authorizeStandaloneCaller } from '@/lib/standalone-accounting/auth';
import { getChatById } from '@/lib/data/persistence-store';
import { launchWebsiteBrowser } from '@/lib/research/website-evidence';
import { qualifyDocument } from '@/lib/documents/qualification';
import { documentLinks, documentStore } from '@/lib/documents/storage';

export const runtime = 'nodejs';
export const maxDuration = 120;
export const dynamic = 'force-dynamic';
const schema = z.object({ actorId: z.string().uuid(), chatId: z.string().uuid() }).strict();
// Fixed synthetic fixture only. No inference, arbitrary content, URLs or renderer options.
// Scope authorization and private delivery are identical to real document production.
export async function POST(request: Request) {
  try {
    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(request.url).origin) return Response.json({ error: 'Origin denied.' }, { status: 403 });
    const scope = schema.parse(await request.json());
    const ownerId = await authorizeStandaloneCaller(request, scope.actorId, scope.chatId);
    const chat = await getChatById(scope.chatId);
    if (!chat || chat.actorId !== scope.actorId) throw new Error('scope');
    const browser = await launchWebsiteBrowser();
    const timer = setTimeout(() => { void browser.close().catch(() => undefined); }, 90000);
    try {
      const produced = await qualifyDocument(browser, Date.now() + 90000);
      if (!produced.corrections || !produced.attempts[0].findings.some(f => f.rule === 'overflow')) throw new Error('Correction was not qualified.');
      const store = documentStore();
      const receipt = await store.save({ ...scope, ownerId, requestId: 'document-qualification-v1' }, produced, produced.inspection, produced.corrections);
      await Promise.all((['docx', 'pdf'] as const).map(format => store.read({ ...scope, ownerId }, receipt.id, format)));
      return Response.json({ qualified: true, receipt, downloads: documentLinks(receipt),
        inspection: produced.inspection, corrections: produced.corrections, inferenceCalls: 0,
        images: produced.images.map(image => image.toString('base64')),
      }, { headers: { 'Cache-Control': 'private, no-store' } });
    } finally { clearTimeout(timer); await browser.close().catch(() => undefined); }
  } catch {
    return Response.json({ qualified: false, error: 'Document qualification failed or scope was denied. No successful delivery is claimed.' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }
}
