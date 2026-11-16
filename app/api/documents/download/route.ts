import { authenticateStandalonePrincipal, authorizeStandaloneCaller } from '@/lib/standalone-accounting/auth';
import { getChatById } from '@/lib/data/persistence-store';
import { documentStore } from '@/lib/documents/storage';
import { createDocumentDownload } from '@/lib/documents/download';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = createDocumentDownload({ authenticate: authenticateStandalonePrincipal, authorize: authorizeStandaloneCaller,
  chat: getChatById, store: documentStore, ownerId: process.env.KATIE_OWNER_AUTH_USER_ID });
