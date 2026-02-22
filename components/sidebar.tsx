const ACTORS = [
  {
    name: 'Web Designer',
    avatarUrl: 'https://images.unsplash.com/photo-1607746882042-944635dfe10e?w=96&h=96&fit=crop',
    chats: ['Project A Landing Page', 'Project B Header Fix']
  },
  {
    name: 'Financial Analyst',
    avatarUrl: 'https://images.unsplash.com/photo-1542204625-de293a93b13c?w=96&h=96&fit=crop',
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
            <div className="flex items-center gap-3">
              {actor.avatarUrl ? (
                <img
                  src={actor.avatarUrl}
                  alt={`${actor.name} avatar`}
                  className="h-9 w-9 rounded-full object-cover"
                />
              ) : null}
              <p className="font-medium text-zinc-100">{actor.name}</p>
            </div>
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
