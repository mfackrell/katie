// app/page.tsx

export default function Page() {
  return (
    <div className="flex h-full">
       <div className="flex-1 flex flex-col items-center justify-center bg-zinc-900 text-zinc-500">
          <i className="fa-solid fa-bolt text-4xl mb-4 opacity-20"></i>
          <p className="text-sm font-medium uppercase tracking-widest">Select an Actor to begin</p>
       </div>
    </div>
  );
}
