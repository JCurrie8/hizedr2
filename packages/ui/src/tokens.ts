/**
 * Hized brand tokens — ported from the marketing site (hized-web
 * components/HizedSite.jsx `const C` object) so the product app and the
 * marketing site never drift out of sync. This is the single source of
 * truth; theme.css derives the Tailwind `@theme` variables from these.
 */
export const colors = {
  ink: "#0A1F33",
  navy: "#0F2A43",
  navy2: "#123350",
  teal: "#17A2A6",
  tealDeep: "#0E7C80",
  canvas: "#F4F7F8",
  panel: "#FFFFFF",
  line: "#DCE4E7",
  muted: "#5B6B76",
  text: "#12242F",
  green: "#1E9E6A",
  amber: "#E0A423",
  red: "#D64545",
  mist: "#8FA8B6",
} as const;

export const fonts = {
  sans: "Inter, system-ui, sans-serif",
  display: "'Space Grotesk', sans-serif",
  mono: "'IBM Plex Mono', monospace",
} as const;

export type BrandColor = keyof typeof colors;
