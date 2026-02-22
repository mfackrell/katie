'use client';

import { useState } from 'react';
import NewActorModal from './NewActorModal';

export default function CreateActorTrigger() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="p-4">
        <button
          onClick={() => setOpen(true)}
          className="w-full flex items-center justify-center gap-2 py-2 px-4 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg transition-all text-sm font-medium"
        >
          <i className="fa-solid fa-plus text-xs"></i> New Actor
        </button>
      </div>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="absolute inset-0" onClick={() => setOpen(false)} />
          <div className="relative z-10 w-full max-w-md">
            <NewActorModal />
          </div>
        </div>
      )}
    </>
  );
}
