// User → color assignment. Single source of truth shared with the web app
// (PLAN.md's curated 12-color palette) so blame gutters, cursors, and avatar
// chips agree on a user's color everywhere.

export type UserColor = { color: string; light: string };

const PALETTE: UserColor[] = [
  { color: "#f59e0b", light: "#fef3c7" }, // amber
  { color: "#0d9488", light: "#ccfbf1" }, // teal
  { color: "#e11d48", light: "#ffe4e6" }, // rose
  { color: "#7c3aed", light: "#ede9fe" }, // violet
  { color: "#65a30d", light: "#ecfccb" }, // lime
  { color: "#0891b2", light: "#cffafe" }, // cyan
  { color: "#ea580c", light: "#ffedd5" }, // orange
  { color: "#2563eb", light: "#dbeafe" }, // blue
  { color: "#be185d", light: "#fce7f3" }, // pink
  { color: "#15803d", light: "#dcfce7" }, // green
  { color: "#a16207", light: "#fef3c7" }, // gold
  { color: "#6d28d9", light: "#e9d5ff" }, // purple
];

function hashStr(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function colorForUser(id: string): UserColor {
  return PALETTE[hashStr(id) % PALETTE.length];
}
