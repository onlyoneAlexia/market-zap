"use client";

import { useEffect, useState, useCallback, type CSSProperties } from "react";

/* ─────────────────────────────────────────────
   Privacy overlay — scoped to a parent container.
   Renders CRT scanlines, film grain, vignette,
   cobwebs, tiny spiders, and PRIVATE watermark.
   Parent must be `relative overflow-hidden`.
   ───────────────────────────────────────────── */

interface PrivacyOverlayProps {
  active: boolean;
}

// ── Corner cobweb SVG ──
function Cobweb({
  className,
  active,
  style,
}: {
  className: string;
  active: boolean;
  style?: CSSProperties;
}) {
  return (
    <div className={className} style={style}>
      <svg viewBox="0 0 120 120" className="w-full h-full">
        {/* Radial threads from corner */}
        {[15, 30, 45, 60, 75].map((angle) => {
          const rad = (angle * Math.PI) / 180;
          return (
            <line
              key={angle}
              x1="0" y1="0"
              x2={Math.cos(rad) * 120} y2={Math.sin(rad) * 120}
              stroke="rgba(130,145,165,0.12)"
              strokeWidth="0.4"
            />
          );
        })}
        {/* Connecting arcs */}
        {[25, 50, 75, 100].map((r) => (
          <path
            key={r}
            d={`M ${r * 0.26},${r * 0.97} Q ${r * 0.5},${r * 0.5} ${r * 0.97},${r * 0.26}`}
            stroke="rgba(140,155,175,0.07)"
            strokeWidth="0.3"
            fill="none"
          />
        ))}
        {/* Dew drops */}
        <circle cx="20" cy="48" r="0.8" fill="rgba(160,180,210,0.25)" className={active ? "animate-pulse" : ""} />
        <circle cx="48" cy="20" r="0.6" fill="rgba(160,180,210,0.25)" className={active ? "animate-pulse" : ""} style={{ animationDelay: "1.5s" }} />
        <circle cx="35" cy="35" r="0.7" fill="rgba(160,180,210,0.25)" className={active ? "animate-pulse" : ""} style={{ animationDelay: "2.5s" }} />
      </svg>
    </div>
  );
}

// ── Tiny spider SVG ──
function TinySpider({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 12 10" className={className} fill="none">
      {/* Body */}
      <ellipse cx="6" cy="5" rx="2" ry="2.5" fill="rgba(100,115,140,0.5)" />
      <circle cx="6" cy="2.5" r="1.2" fill="rgba(100,115,140,0.55)" />
      {/* Legs — 4 per side */}
      <path d="M4.5,3.5 Q2,1 0.5,2" stroke="rgba(100,115,140,0.4)" strokeWidth="0.4" />
      <path d="M4,4.5 Q1.5,3.5 0,4.5" stroke="rgba(100,115,140,0.4)" strokeWidth="0.4" />
      <path d="M4,5.5 Q1.5,6 0,5.5" stroke="rgba(100,115,140,0.4)" strokeWidth="0.4" />
      <path d="M4.5,6.5 Q2.5,8.5 1,8" stroke="rgba(100,115,140,0.4)" strokeWidth="0.4" />
      <path d="M7.5,3.5 Q10,1 11.5,2" stroke="rgba(100,115,140,0.4)" strokeWidth="0.4" />
      <path d="M8,4.5 Q10.5,3.5 12,4.5" stroke="rgba(100,115,140,0.4)" strokeWidth="0.4" />
      <path d="M8,5.5 Q10.5,6 12,5.5" stroke="rgba(100,115,140,0.4)" strokeWidth="0.4" />
      <path d="M7.5,6.5 Q9.5,8.5 11,8" stroke="rgba(100,115,140,0.4)" strokeWidth="0.4" />
    </svg>
  );
}

// Spider configs — each walks a different path along the card edges
const SPIDERS = [
  // Top edge: left → right, slow
  { anim: "spiderWalkTop", dur: "28s", delay: "2s", size: "w-3 h-2.5" },
  // Right edge: top → bottom
  { anim: "spiderWalkRight", dur: "35s", delay: "8s", size: "w-2.5 h-2" },
  // Bottom edge: right → left
  { anim: "spiderWalkBottom", dur: "32s", delay: "15s", size: "w-3 h-2.5" },
] as const;

export function PrivacyOverlay({ active }: PrivacyOverlayProps) {
  const baseTransition = "transition-opacity ease-in-out";
  const baseTransitionStyle = { transitionDuration: "1200ms" } as const;
  const vis = active ? "opacity-100" : "opacity-0 pointer-events-none";

  return (
    <>
      {/* Dark card background — sits behind card content */}
      <div
        className={`absolute inset-0 z-0 ${baseTransition} ${vis}`}
        style={{
          ...baseTransitionStyle,
          background: `
            radial-gradient(ellipse at 30% 80%, rgba(12,18,30,0.6) 0%, transparent 50%),
            radial-gradient(ellipse at 70% 20%, rgba(8,14,25,0.4) 0%, transparent 50%),
            linear-gradient(180deg, rgba(8,12,20,0.95) 0%, rgba(10,16,28,0.98) 100%)
          `,
        }}
      />

      {/* CRT scanlines — very subtle, just enough to feel "monitored" */}
      <div
        className={`absolute inset-0 z-[1] pointer-events-none ${baseTransition} delay-300 ${vis}`}
        style={{
          ...baseTransitionStyle,
          background: "repeating-linear-gradient(0deg, transparent 0px, transparent 3px, rgba(0,0,0,0.02) 3px, rgba(0,0,0,0.02) 4px)",
        }}
      />

      {/* Film grain — SVG feTurbulence noise */}
      <div
        className={`absolute inset-0 z-[2] pointer-events-none ${baseTransition} delay-500 ${vis}`}
        style={baseTransitionStyle}
      >
        <svg className="absolute inset-0 w-full h-full opacity-[0.02]">
          <filter id="privacyGrain">
            <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="4" stitchTiles="stitch" />
            <feColorMatrix type="saturate" values="0" />
          </filter>
          <rect width="100%" height="100%" filter="url(#privacyGrain)" />
        </svg>
      </div>

      {/* Vignette — darkened edges */}
      <div
        className={`absolute inset-0 z-[3] pointer-events-none ${baseTransition} delay-200 ${vis}`}
        style={{
          ...baseTransitionStyle,
          background: "radial-gradient(ellipse 80% 70% at 50% 50%, transparent 0%, rgba(5,8,15,0.35) 100%)",
        }}
      />

      {/* Cobwebs — top-left and top-right corners */}
      <Cobweb
        active={active}
        className={`absolute top-0 left-0 w-[90px] h-[90px] z-[4] pointer-events-none blur-[0.2px] ${baseTransition} delay-500 ${vis}`}
        style={baseTransitionStyle}
      />
      <Cobweb
        active={active}
        className={`absolute top-0 right-0 w-[75px] h-[75px] z-[4] pointer-events-none blur-[0.2px] -scale-x-100 ${baseTransition} delay-700 ${vis}`}
        style={baseTransitionStyle}
      />
      <Cobweb
        active={active}
        className={`absolute bottom-0 right-0 w-[60px] h-[60px] z-[4] pointer-events-none blur-[0.2px] -scale-100 ${baseTransition} ${vis}`}
        style={{ ...baseTransitionStyle, transitionDelay: "900ms" }}
      />

      {/* Tiny spiders — walking along card edges */}
      {SPIDERS.map((s, i) => (
        <div
          key={i}
          className={`absolute z-[5] pointer-events-none ${baseTransition} ${vis}`}
          style={{
            ...baseTransitionStyle,
            transitionDelay: "1500ms",
            animation: `${s.anim} ${s.dur} linear infinite`,
            animationDelay: s.delay,
          }}
        >
          <TinySpider className={s.size} />
        </div>
      ))}

      {/* Spider silk thread — hangs from top-left cobweb */}
      <div
        className={`absolute z-[4] pointer-events-none ${baseTransition} ${vis}`}
        style={{
          ...baseTransitionStyle,
          transitionDelay: "1200ms",
          top: 60,
          left: 25,
          width: 1,
          height: 80,
          background: "linear-gradient(180deg, rgba(140,155,175,0.12), rgba(140,155,175,0.03) 70%, transparent)",
        }}
      >
        {/* Spider dangling at the end of the thread */}
        <div className="absolute -bottom-1 -left-[5px] animate-[spiderDangle_4s_ease-in-out_infinite]">
          <TinySpider className="w-2.5 h-2" />
        </div>
      </div>

      {/* Faint PRIVATE watermark pattern */}
      <div
        className={`absolute inset-0 z-[1] pointer-events-none overflow-hidden ${baseTransition} delay-700 ${vis}`}
        style={{ ...baseTransitionStyle, transform: "rotate(-35deg)", transformOrigin: "center" }}
      >
        <div className="absolute inset-[-50%] flex flex-wrap gap-x-16 gap-y-10 items-center justify-center">
          {Array.from({ length: 30 }, (_, i) => (
            <span
              key={i}
              className="text-[10px] font-mono tracking-[0.3em] select-none"
              style={{ color: "rgba(100, 120, 150, 0.04)" }}
            >
              PRIVATE
            </span>
          ))}
        </div>
      </div>
    </>
  );
}

/* ─────────────────────────────────────────────
   Scanline sweep + flash transition (full-page,
   momentary — this is fine as full-page since
   it only lasts ~1s)
   ───────────────────────────────────────────── */

export function useScanlineEffect() {
  const fire = useCallback((mode: "dark" | "clean") => {
    const isDark = mode === "dark";

    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:10000;pointer-events:none;overflow:hidden;";

    // Beam
    const beam = document.createElement("div");
    const scanColor = isDark ? "rgba(100,130,170,0.6)" : "rgba(34,211,238,0.6)";
    const scanGlow = isDark ? "rgba(100,130,170,0.3)" : "rgba(34,211,238,0.3)";
    beam.style.cssText = `
      position:absolute;left:0;width:100%;height:4px;
      background:linear-gradient(90deg, transparent 0%, ${scanColor} 15%, ${scanColor} 50%, ${scanColor} 85%, transparent 100%);
      box-shadow:0 0 30px ${scanGlow},0 0 80px ${scanGlow},0 -2px 10px ${scanGlow},0 2px 10px ${scanGlow};
      animation:${isDark ? "dfScanDown" : "dfScanUp"} 0.9s ease-in-out forwards;
    `;
    overlay.appendChild(beam);

    // Trail
    const trail = document.createElement("div");
    trail.style.cssText = `
      position:absolute;left:0;width:100%;
      animation:${isDark ? "dfScanDown" : "dfScanUp"} 0.9s ease-in-out forwards;
    `;
    const trailInner = document.createElement("div");
    const trailColor = isDark ? "rgba(50,70,100,0.08)" : "rgba(34,211,238,0.06)";
    trailInner.style.cssText = `
      height:60px;
      background:linear-gradient(${isDark ? "180deg" : "0deg"}, ${trailColor}, transparent);
      transform:translateY(${isDark ? "-60px" : "0"});
    `;
    trail.appendChild(trailInner);
    overlay.appendChild(trail);

    document.body.appendChild(overlay);

    // Flash
    const flash = document.createElement("div");
    const flashBg = isDark ? "rgba(30,45,65,0.1)" : "rgba(34,211,238,0.05)";
    flash.style.cssText = `
      position:fixed;inset:0;z-index:9999;pointer-events:none;
      background:${flashBg};
      animation:dfFlash 0.5s ease-out 0.4s forwards;
      opacity:0;
    `;
    document.body.appendChild(flash);

    setTimeout(() => {
      overlay.remove();
      flash.remove();
    }, 1500);
  }, []);

  return fire;
}
