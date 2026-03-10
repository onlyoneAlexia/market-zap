import { ImageResponse } from "next/og";

export const size = {
  width: 512,
  height: 512,
};

export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          alignItems: "center",
          background: "#141210",
          borderRadius: 96,
          display: "flex",
          height: "100%",
          justifyContent: "center",
          width: "100%",
        }}
      >
        <svg
          width="380"
          height="340"
          viewBox="0 0 380 340"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <polyline
            points="20,220 70,220 120,60 170,280 220,20 270,220 340,220"
            stroke="#E85D4A"
            strokeWidth="32"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
          <circle cx="220" cy="20" r="24" fill="#E85D4A" opacity="0.4" />
        </svg>
      </div>
    ),
    size,
  );
}
