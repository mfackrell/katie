"use client";

import { useMemo, useState } from "react";
import { ChatPanel } from "@/components/chat-panel";
import { Sidebar } from "@/components/sidebar";
import { demoActors, demoChats } from "@/lib/data/mock";

export default function HomePage() {
  const [activeActorId, setActiveActorId] = useState(demoActors[0].id);
  const [activeChatId, setActiveChatId] = useState(demoChats[0].id);

  const filteredChats = useMemo(() => demoChats, []);

  return (
    <div className="flex min-h-screen bg-zinc-950 text-zinc-100">
      <Sidebar
        actors={demoActors}
        chats={filteredChats}
        activeActorId={activeActorId}
        activeChatId={activeChatId}
        onSelectActor={setActiveActorId}
        onSelectChat={setActiveChatId}
      />
      <ChatPanel actorId={activeActorId} chatId={activeChatId} />
    </div>
  );
}
