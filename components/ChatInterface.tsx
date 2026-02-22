'use client';
import { useChat } from 'ai/react'; // Vercel's hook for streaming

export default function ChatInterface({ actorId, chatId }: { actorId: string, chatId: string }) {
  const { messages, input, handleInputChange, handleSubmit, isLoading } = useChat({
    api: '/api/chat',
    body: { actorId, chatId },
  });

  return (
    // Inside your ChatInterface component return statement
    <div className="flex-1 overflow-y-auto scroll-smooth">
      <div className="max-w-3xl mx-auto py-10 px-4 space-y-8">
        {messages.map((m) => (
          <div key={m.id} className="group flex gap-4 transition-all animate-in fade-in slide-in-from-bottom-2">
            {/* Avatar Section */}
            <div className={`w-8 h-8 rounded-md flex items-center justify-center text-xs font-bold shrink-0 shadow-md ${
              m.role === 'user' ? 'bg-zinc-700' : 'bg-blue-600 text-white'
            }`}>
              {m.role === 'user' ? 'MF' : <i className="fa-solid fa-bolt text-[10px]" />}
            </div>
            
            {/* Message Content */}
            <div className="flex-1 space-y-2 overflow-hidden">
              <p className="text-sm font-semibold text-zinc-400 uppercase tracking-tight text-[10px]">
                {m.role === 'user' ? 'You' : 'Orchestrator'}
              </p>
              <div className="text-sm leading-relaxed text-zinc-200 prose prose-invert max-w-none">
                {m.content}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
    
    {/* The Input Area: Floating and Centered */}
    <div className="p-4 bg-gradient-to-t from-zinc-900 via-zinc-900 to-transparent">
      <div className="max-w-3xl mx-auto relative group">
        <textarea 
          className="w-full bg-zinc-800 border border-zinc-700 focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500 rounded-2xl py-4 pl-4 pr-12 text-sm resize-none shadow-2xl transition-all"
          placeholder="Message your Actor..."
          rows={1}
        />
        <button className="absolute right-3 bottom-3 p-1.5 bg-zinc-100 text-black rounded-lg hover:bg-white transition-colors">
          <i className="fa-solid fa-arrow-up" />
        </button>
      </div>
      <p className="text-[10px] text-center text-zinc-600 mt-2 uppercase tracking-widest font-medium">
        Tri-Layer Memory: Permanent • Intermediary • Ephemeral
      </p>
    </div>
  );
}
