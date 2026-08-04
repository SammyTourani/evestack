"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";

const options = ["system", "light", "dark"] as const;

export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <div
      role="group"
      aria-label="Display theme"
      className="inline-flex items-center rounded-full border border-border-default p-0.5"
    >
      {options.map((opt) => {
        const active = mounted && theme === opt;
        return (
          <button
            key={opt}
            type="button"
            aria-pressed={active}
            onClick={() => setTheme(opt)}
            className={
              "rounded-full px-3 py-1 font-mono text-label-12 uppercase transition-colors " +
              (active ? "bg-gray-200 text-gray-1000" : "text-gray-700 hover:text-gray-1000")
            }
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}
