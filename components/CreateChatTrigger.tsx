'use client';

import { useState } from 'react';
import { createChatAction } from '@/app/actions/chats';

export default function CreateChatTrigger({ actorId }: { actorId: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="w-full text-left px-3 py-2 text-xs text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900 rounded-md"
      >
        + New chat
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="absolute inset-0" onClick={() => setOpen(false)} />
          <form
            action={async (formData) => {
              const title = String(formData.get('title') ?? '').trim();
              if (!title) {
                return;
              }
              await createChatAction(actorId, title);
              setOpen(false);
            }}
            className="relative z-10 bg-zinc-900 border border-zinc-800 rounded-xl p-5 w-full max-w-sm space-y-3"
          >
            <h3 className="text-sm font-semibold text-zinc-200">Create chat</h3>
            <input
              autoFocus
              name="title"
              placeholder="Chat title"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg p-2 text-sm focus:outline-none focus:border-zinc-500"
            />
            <button
              type="submit"
              className="w-full bg-zinc-100 text-black text-sm font-medium rounded-lg py-2 hover:bg-white"
            >
              Create
            </button>
          </form>
        </div>
      )}
    </>
  );
}
