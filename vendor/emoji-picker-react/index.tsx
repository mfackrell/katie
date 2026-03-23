"use client";

import { useMemo, useState } from "react";

export const Theme = {
  DARK: "dark",
  LIGHT: "light",
} as const;

type ThemeValue = (typeof Theme)[keyof typeof Theme];

type EmojiClickData = {
  emoji: string;
};

type EmojiPickerProps = {
  onEmojiClick: (emojiData: EmojiClickData) => void;
  theme?: ThemeValue;
  autoFocusSearch?: boolean;
  lazyLoadEmojis?: boolean;
  skinTonesDisabled?: boolean;
  width?: number;
  height?: number;
};

const EMOJIS = [
  "😀","😄","😁","😂","😊","😍","🥳","🤖","🔥","✨","🎯","🚀",
  "👍","👏","🙌","🙏","💡","🧠","📎","✅","❌","⚠️","❤️","🎉",
  "👋","🤝","💬","📷","📄","🛠️","🌟","😎","🤔","😅","🙃","🤩",
];

export default function EmojiPicker({
  onEmojiClick,
  theme = Theme.LIGHT,
  autoFocusSearch = false,
  width = 320,
  height = 400,
}: EmojiPickerProps) {
  const [query, setQuery] = useState("");

  const filteredEmojis = useMemo(() => {
    if (!query.trim()) {
      return EMOJIS;
    }

    return EMOJIS.filter((emoji) => emoji.includes(query.trim()));
  }, [query]);

  const darkMode = theme === Theme.DARK;

  return (
    <div
      className={[
        "flex flex-col",
        darkMode ? "bg-zinc-950 text-zinc-100" : "bg-white text-zinc-900",
      ].join(" ")}
      style={{ width, height }}
    >
      <div className="border-b border-white/10 p-3">
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search emojis"
          autoFocus={autoFocusSearch}
          className={[
            "w-full rounded-xl border px-3 py-2 text-sm outline-none",
            darkMode
              ? "border-white/10 bg-zinc-900 text-zinc-100 placeholder:text-zinc-500"
              : "border-zinc-200 bg-zinc-50 text-zinc-900 placeholder:text-zinc-400",
          ].join(" ")}
        />
      </div>
      <div className="grid flex-1 grid-cols-6 gap-2 overflow-y-auto p-3">
        {filteredEmojis.map((emoji) => (
          <button
            key={emoji}
            type="button"
            onClick={() => onEmojiClick({ emoji })}
            className={[
              "flex h-10 w-10 items-center justify-center rounded-xl text-xl transition",
              darkMode
                ? "bg-white/[0.04] hover:bg-white/[0.08]"
                : "bg-zinc-100 hover:bg-zinc-200",
            ].join(" ")}
            aria-label={`Insert ${emoji}`}
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
}
