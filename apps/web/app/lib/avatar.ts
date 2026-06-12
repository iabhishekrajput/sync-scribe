// Avatar utilities — "user → color + initials". The curated 12-color
// palette lives in @syncscribe/client so blame gutters, presence cursors,
// and avatar chips agree on a user's color everywhere.

export { colorForUser, type UserColor } from "@syncscribe/client";

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
