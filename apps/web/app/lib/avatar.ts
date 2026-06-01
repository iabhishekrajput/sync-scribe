// Avatar utilities — single source of truth for "user → color + initials".

// 12-color curated palette. Round-robin assignment per session keeps live
// cursors distinct at small N; for the dashboard/topbar we hash to one of
// these slots so the same user gets the same color across reloads.
const PALETTE = [
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

export function colorForUser(id: string) {
  return PALETTE[hashStr(id) % PALETTE.length];
}

// "Monkey D Luffy" → "ML"; "luffy@anekdote.in" → "LU"; "" → "?".
export function initials(name?: string | null): string {
  const n = (name ?? "").trim();
  if (!n) return "?";
  const parts = n.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 1) {
    const p = parts[0];
    return (p.length >= 2 ? p.slice(0, 2) : p).toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
