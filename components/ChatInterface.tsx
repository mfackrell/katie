'use client';
import { useChat } from 'ai/react'; // Vercel's hook for streaming

export default function ChatInterface({ actorId, chatId }: { actorId: string, chatId: string }) {
  const { messages, input, handleInputChange, handleSubmit, isLoading } = useChat({
    api: '/api/chat',
    body: { actorId, chatId },
  });

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map(m => (
          <div key={m.id} className={`p-4 rounded-lg ${m.role === 'user' ? 'bg-zinc-800 ml-auto max-w-[80%]' : 'bg-zinc-900 border border-zinc-800'}`}>
            <p className="text-sm">{m.content}</p>
          </div>
        ))}
        {isLoading && <div className="text-xs text-zinc-500 animate-pulse">Master Router selecting best model...</div>}
      </div>

      <form onSubmit={handleSubmit} className="p-4 bg-zinc-950 border-t border-zinc-800">
        <input 
          value={input} 
          onChange={handleInputChange} 
          placeholder="Message your Actor..."
          className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-3 text-sm focus:outline-none focus:border-blue-500"
        />
      </form>
    </div>
  );
}
