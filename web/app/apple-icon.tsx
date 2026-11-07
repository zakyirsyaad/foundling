import { ImageResponse } from "next/og";

/** iOS rounds the corners itself, so this is the icon.svg mark on a square tile. */
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <svg width="180" height="180" viewBox="0 0 32 32">
        <rect width="32" height="32" fill="#171717" />
        <path d="M11 8h11v3.5h-7v3.25h6v3.5h-6V24h-4z" fill="#fafafa" />
      </svg>
    ),
    size,
  );
}
