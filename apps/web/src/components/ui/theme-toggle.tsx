"use client";

import { useTheme } from "next-themes";
import { useEffect, useRef, useState, useCallback } from "react";
import { animate } from "animejs";

export function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const sunRef = useRef<SVGSVGElement>(null);
  const moonRef = useRef<SVGSVGElement>(null);
  const monitorRef = useRef<SVGSVGElement>(null);
  const raysRef = useRef<SVGGElement>(null);

  useEffect(() => setMounted(true), []);

  const next =
    theme === "dark" ? "light" : theme === "light" ? "system" : "dark";
  const label =
    theme === "dark"
      ? "Dark mode"
      : theme === "light"
        ? "Light mode"
        : "System theme";

  const handleClick = useCallback(() => {
    const btn = btnRef.current;
    if (!btn) return;

    // Button pop
    animate(btn, {
      scale: [1, 0.85, 1.1, 1],
      duration: 400,
      ease: "outElastic(1, .6)",
    });

    // Animate out current icon, then switch
    const currentIcon =
      theme === "dark"
        ? moonRef.current
        : theme === "light"
          ? sunRef.current
          : monitorRef.current;

    if (currentIcon) {
      animate(currentIcon, {
        scale: [1, 0],
        rotate: [0, theme === "dark" ? -90 : 90],
        opacity: [1, 0],
        duration: 250,
        ease: "inQuad",
        onComplete: () => {
          setTheme(next);
        },
      });
    } else {
      setTheme(next);
    }
  }, [theme, next, setTheme]);

  // Animate in new icon when theme changes
  useEffect(() => {
    if (!mounted) return;

    const incomingIcon =
      theme === "dark"
        ? moonRef.current
        : theme === "light"
          ? sunRef.current
          : monitorRef.current;

    if (incomingIcon) {
      animate(incomingIcon, {
        scale: [0, 1],
        rotate: [theme === "light" ? 90 : -90, 0],
        opacity: [0, 1],
        duration: 400,
        ease: "outElastic(1, .6)",
      });
    }

    // Spin sun rays when entering light mode
    if (theme === "light" && raysRef.current) {
      animate(raysRef.current, {
        rotate: [0, 360],
        duration: 600,
        ease: "outQuad",
      });
    }
  }, [theme, mounted]);

  if (!mounted) {
    return (
      <button
        className="relative flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground opacity-50"
        disabled
      >
        <MoonIcon />
      </button>
    );
  }

  return (
    <button
      ref={btnRef}
      onClick={handleClick}
      className="relative flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      aria-label={label}
      title={label}
    >
      {theme === "dark" && (
        <svg
          ref={moonRef}
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ transformOrigin: "center" }}
        >
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
        </svg>
      )}
      {theme === "light" && (
        <svg
          ref={sunRef}
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ transformOrigin: "center" }}
        >
          <circle cx="12" cy="12" r="4" />
          <g ref={raysRef} style={{ transformOrigin: "center" }}>
            <path d="M12 2v2" />
            <path d="M12 20v2" />
            <path d="m4.93 4.93 1.41 1.41" />
            <path d="m17.66 17.66 1.41 1.41" />
            <path d="M2 12h2" />
            <path d="M20 12h2" />
            <path d="m6.34 17.66-1.41 1.41" />
            <path d="m19.07 4.93-1.41 1.41" />
          </g>
        </svg>
      )}
      {theme === "system" && (
        <svg
          ref={monitorRef}
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ transformOrigin: "center" }}
        >
          <rect width="20" height="14" x="2" y="3" rx="2" />
          <line x1="8" x2="16" y1="21" y2="21" />
          <line x1="12" x2="12" y1="17" y2="21" />
        </svg>
      )}
    </button>
  );
}

function MoonIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );
}
