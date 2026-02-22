const ACTORS = [
  {
    name: 'Web Designer',
    chats: ['Project A Landing Page', 'Project B Header Fix']
  },
  {
    name: 'Financial Analyst',
    chats: ['Q2 Forecast', 'Runway Sensitivity']
  }
];

export function Sidebar() {
  return (
    <aside className="w-80 border-r border-zinc-800 bg-zinc-900/50 p-4">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-zinc-400">Actors</h2>
      <ul className="space-y-4">
        {ACTORS.map((actor) => (
          <li key={actor.name} className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
            <p className="font-medium text-zinc-100">{actor.name}</p>
            <ul className="mt-2 space-y-1 text-sm text-zinc-400">
              {actor.chats.map((chat) => (
                <li key={chat} className="rounded-md px-2 py-1 hover:bg-zinc-800 hover:text-zinc-200">
                  {chat}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </aside>
  );
}
