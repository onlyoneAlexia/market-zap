import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

const config: Config = {
  darkMode: ["class"],
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        /* Trading semantic colors */
        yes: {
          DEFAULT: "hsl(var(--yes))",
          foreground: "hsl(var(--yes-foreground))",
          muted: "hsl(var(--yes-muted))",
        },
        no: {
          DEFAULT: "hsl(var(--no))",
          foreground: "hsl(var(--no-foreground))",
          muted: "hsl(var(--no-muted))",
        },
        /* Terminal accent colors */
        cyan: "hsl(var(--cyan))",
        amber: "hsl(var(--amber))",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: ["var(--font-space-grotesk, Space Grotesk)", "system-ui", "sans-serif"],
        heading: ["var(--font-space-grotesk, Space Grotesk)", "system-ui", "sans-serif"],
        mono: [
          "var(--font-jetbrains, 'JetBrains Mono')",
          "ui-monospace",
          "SFMono-Regular",
          "monospace",
        ],
      },
      transitionTimingFunction: {
        snappy: "cubic-bezier(0.2, 0, 0, 1)",
        swift: "cubic-bezier(0.16, 1, 0.3, 1)",
      },
      transitionDuration: {
        snappy: "220ms",
        swift: "500ms",
      },
      fontSize: {
        "price-lg": ["2rem", { lineHeight: "1.1", fontWeight: "600" }],
        "price-md": ["1.25rem", { lineHeight: "1.2", fontWeight: "600" }],
        "price-sm": ["0.875rem", { lineHeight: "1.3", fontWeight: "500" }],
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "fade-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "fade-out": {
          from: { opacity: "1", transform: "translateY(0)" },
          to: { opacity: "0", transform: "translateY(4px)" },
        },
        "slide-in-right": {
          from: { transform: "translateX(100%)" },
          to: { transform: "translateX(0)" },
        },
        "price-flash-up": {
          "0%": { backgroundColor: "hsl(var(--yes) / 0.2)" },
          "100%": { backgroundColor: "transparent" },
        },
        "price-flash-down": {
          "0%": { backgroundColor: "hsl(var(--no) / 0.2)" },
          "100%": { backgroundColor: "transparent" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        pulse: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.5" },
        },
        appear: {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "stat-reveal": {
          "0%": {
            opacity: "0",
            transform: "translateY(20px) scale(0.95)",
          },
          "60%": {
            opacity: "1",
            transform: "translateY(-4px) scale(1.02)",
          },
          "100%": {
            opacity: "1",
            transform: "translateY(0) scale(1)",
          },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "fade-in": "fade-in 0.3s ease-out",
        "fade-out": "fade-out 0.2s ease-out",
        "slide-in-right": "slide-in-right 0.3s ease-out",
        "price-flash-up": "price-flash-up 0.6s ease-out",
        "price-flash-down": "price-flash-down 0.6s ease-out",
        shimmer: "shimmer 2s infinite linear",
        pulse: "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        appear: "appear 0.5s cubic-bezier(0.16, 1, 0.3, 1) both",
        "stat-reveal":
          "stat-reveal 0.7s cubic-bezier(0.16, 1, 0.3, 1) both",
      },
      backgroundImage: {
        "shimmer-gradient":
          "linear-gradient(90deg, transparent, hsl(var(--muted) / 0.4), transparent)",
      },
    },
  },
  plugins: [animate],
};

export default config;
