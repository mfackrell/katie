"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
const destinations = [
  ["/", "Home", "⌂"],
  ["/conversations", "Conversations", "◌"],
  ["/work", "Work", "□"],
  ["/specialists", "Specialists", "◇"],
  ["/settings", "Settings", "⚙"],
];
export function ApplicationShell({
  children,
  legacy = false,
}: {
  children: React.ReactNode;
  legacy?: boolean;
}) {
  const path = usePathname(),
    [open, setOpen] = useState(false),
    trigger = useRef<HTMLButtonElement>(null),
    drawer = useRef<HTMLElement>(null);
  useEffect(() => {
    setOpen(false);
  }, [path]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    drawer.current?.querySelector<HTMLAnchorElement>("a")?.focus();
    const keyboard = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
      if (e.key === "Tab") {
        const controls =
          drawer.current?.querySelectorAll<HTMLElement>("a,button");
        if (!controls?.length) return;
        const first = controls[0],
          last = controls[controls.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("keydown", keyboard);
      previous?.focus();
    };
  }, [open]);
  useEffect(() => {
    const content = document.getElementById("main-content");
    if (!content) return;
    let frame = 0;
    const key = `katie.position.v1.${path}`;
    const save = () => {
      try {
        sessionStorage.setItem(key, String(content.scrollTop));
      } catch {}
    };
    try {
      const y = Number(sessionStorage.getItem(key) ?? 0);
      frame = requestAnimationFrame(() => {
        content.scrollTop = y;
      });
    } catch {}
    content.addEventListener("scroll", save, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      content.removeEventListener("scroll", save);
    };
  }, [path]);
  if (
    (legacy && path === "/") ||
    path === "/legacy" ||
    path.startsWith("/project-pilots")
  )
    return <>{children}</>;
  const navigation = (
    <>
      <Link
        className="mb-8 block text-2xl font-semibold tracking-tight"
        href="/"
      >
        Katie<span className="ml-1 text-emerald-400">.</span>
      </Link>
      <Link
        href="/conversations/new"
        className="mb-8 block rounded-xl bg-emerald-400 px-4 py-3 text-center text-sm font-semibold text-zinc-950"
      >
        + New conversation
      </Link>
      <Link
        className="mb-4 block min-h-11 rounded-xl border border-white/10 px-3 py-3 text-sm text-zinc-400"
        href="/search"
      >
        Search Katie…
      </Link>
      <nav aria-label="Main navigation" className="space-y-2">
        {destinations.map(([href, label, icon]) => {
          const active = href === "/" ? path === "/" : path.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`flex min-h-11 items-center gap-3 rounded-xl px-3 py-3 text-sm ${active ? "bg-white/10 font-medium text-white" : "text-zinc-400 hover:bg-white/5 hover:text-white"}`}
            >
              <span aria-hidden className="w-5 text-lg">
                {icon}
              </span>
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto pt-10 text-xs leading-5 text-zinc-500">
        One conversation.
        <br />A coordinated team.
        <Link className="mt-3 block underline" href="/settings">
          Help & preferences
        </Link>
      </div>
    </>
  );
  return (
    <div className="flex h-dvh min-w-0 bg-[#101113] text-zinc-100">
      <a
        className="sr-only focus:not-sr-only focus:absolute focus:z-[100] focus:bg-zinc-900 focus:p-4"
        href="#main-content"
      >
        Skip to content
      </a>
      <aside className="hidden w-60 shrink-0 flex-col border-r border-white/10 bg-[#151619] p-6 lg:flex">
        {navigation}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-white/10 px-4 lg:hidden">
          <button
            ref={trigger}
            aria-expanded={open}
            aria-controls="mobile-navigation"
            aria-label="Open navigation"
            className="min-h-11 min-w-11"
            onClick={() => setOpen(true)}
          >
            ☰
          </button>
          <Link href="/" className="font-semibold">
            Katie
          </Link>
        </header>
        <main
          id="main-content"
          className="min-h-0 min-w-0 flex-1 overflow-auto"
        >
          {children}
        </main>
      </div>
      {open && (
        <div
          className="fixed inset-0 z-50 bg-black/70 lg:hidden"
          onClick={() => setOpen(false)}
        >
          <aside
            id="mobile-navigation"
            ref={drawer}
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="flex h-full w-[min(19rem,90vw)] flex-col bg-zinc-950 p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="mb-4 min-h-11 text-right"
              aria-label="Close navigation"
              onClick={() => setOpen(false)}
            >
              Close ×
            </button>
            {navigation}
          </aside>
        </div>
      )}
    </div>
  );
}
