/**
 * The token values code needs outside CSS: the web manifest, the browser's
 * theme colour and the generated app icons. base.css is the source;
 * contrast.test.ts fails when a value here drifts from it.
 */
export const light = {
  ground: "#ffffff",
  ink: "#111113",
  "on-ink": "#ffffff",
} as const;

export const dark = {
  ground: "#111113",
} as const;
