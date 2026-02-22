import { Sidebar } from '@/components/sidebar';

export default function Home() {
  return (
    <main className="flex min-h-screen">
      <Sidebar />
      <section className="flex flex-1 flex-col">
        <header className="border-b border-zinc-800 px-6 py-4">
          <h1 className="text-xl font-semibold">Polyglot Actor Orchestrator</h1>
          <p className="text-sm text-zinc-400">Tri-layer memory + model routing</p>
        </header>
        <div className="flex-1 p-6">
          <div className="mx-auto max-w-3xl rounded-xl border border-zinc-800 bg-zinc-900 p-6">
            <p className="text-zinc-300">
              Submit prompts to <code className="text-emerald-400">/api/chat</code> with{' '}
              <code className="text-emerald-400">actorId</code> and <code className="text-emerald-400">chatId</code>.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
