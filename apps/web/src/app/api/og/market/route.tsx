import { ImageResponse } from "next/og";
import { NextRequest } from "next/server";

export const runtime = "edge";

const SIZE = { width: 1200, height: 630 };

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;

  const question = searchParams.get("question") ?? "Prediction Market";
  const yesPrice = searchParams.get("yes") ?? "—";
  const noPrice = searchParams.get("no") ?? "—";
  const volume = searchParams.get("volume") ?? "$0";
  const traders = searchParams.get("traders") ?? "0";
  const status = searchParams.get("status") ?? "active";
  const category = searchParams.get("category") ?? "";
  const endDate = searchParams.get("end") ?? "";

  const isResolved = status === "resolved";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: "linear-gradient(145deg, #0a0e17 0%, #141a2b 50%, #0a0e17 100%)",
          padding: "48px 56px",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        {/* Top bar: branding + category */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "32px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <svg
              width="40"
              height="36"
              viewBox="0 0 32 28"
              fill="none"
            >
              <polyline
                points="2,18 7,18 10,8 13,22 16,4 19,18 24,18"
                stroke="#E85D4A"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
              <circle cx="16" cy="4" r="2" fill="#E85D4A" opacity="0.4" />
            </svg>
            <span style={{ color: "#f5f5f5", fontSize: "24px", fontWeight: 700, letterSpacing: "0.05em" }}>
              Market<span style={{ color: "#E85D4A" }}>Zap</span>
            </span>
          </div>

          {category && (
            <div
              style={{
                display: "flex",
                background: "rgba(232,93,74,0.15)",
                color: "#E85D4A",
                padding: "6px 16px",
                borderRadius: "20px",
                fontSize: "16px",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
              }}
            >
              {category}
            </div>
          )}
        </div>

        {/* Question */}
        <div
          style={{
            display: "flex",
            flex: 1,
            alignItems: "flex-start",
          }}
        >
          <span
            style={{
              color: "#f5f5f5",
              fontSize: question.length > 80 ? "36px" : "44px",
              fontWeight: 700,
              lineHeight: 1.25,
              maxWidth: "100%",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {question}
          </span>
        </div>

        {/* Bottom: prices + stats */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: "24px",
          }}
        >
          {/* YES / NO prices */}
          <div style={{ display: "flex", gap: "16px" }}>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                background: isResolved ? "rgba(34,197,94,0.15)" : "rgba(34,197,94,0.1)",
                border: "1px solid rgba(34,197,94,0.3)",
                borderRadius: "16px",
                padding: "16px 32px",
                minWidth: "140px",
              }}
            >
              <span style={{ color: "#9ca3af", fontSize: "14px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                Yes
              </span>
              <span style={{ color: "#22c55e", fontSize: "40px", fontWeight: 800 }}>
                {yesPrice}
              </span>
            </div>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                background: "rgba(239,68,68,0.1)",
                border: "1px solid rgba(239,68,68,0.3)",
                borderRadius: "16px",
                padding: "16px 32px",
                minWidth: "140px",
              }}
            >
              <span style={{ color: "#9ca3af", fontSize: "14px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                No
              </span>
              <span style={{ color: "#ef4444", fontSize: "40px", fontWeight: 800 }}>
                {noPrice}
              </span>
            </div>
          </div>

          {/* Stats column */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-end",
              gap: "6px",
            }}
          >
            <span style={{ color: "#9ca3af", fontSize: "16px" }}>
              Vol {volume} · {traders} traders
            </span>
            {endDate && (
              <span style={{ color: "#6b7280", fontSize: "14px" }}>
                {isResolved ? "Resolved" : `Ends ${endDate}`}
              </span>
            )}
            <span style={{ color: "#4b5563", fontSize: "13px" }}>
              Powered by Starknet
            </span>
          </div>
        </div>
      </div>
    ),
    SIZE,
  );
}
