export type DiffLine = {
  kind: "same" | "added" | "removed";
  text: string;
  beforeLine?: number;
  afterLine?: number;
};

export type LineDiff = {
  lines: DiffLine[];
  truncated: boolean;
};

// LCS-based line diff. Quadratic table — bail out (truncated: true) once
// before×after crosses ~120k cells so a huge doc can't freeze the UI.
export function buildLineDiff(before: string, after: string): LineDiff {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  if (beforeLines.length * afterLines.length > 120000) {
    return { lines: [], truncated: true };
  }

  const rows = beforeLines.length + 1;
  const cols = afterLines.length + 1;
  const table = Array.from({ length: rows }, () => Array<number>(cols).fill(0));
  for (let i = beforeLines.length - 1; i >= 0; i--) {
    for (let j = afterLines.length - 1; j >= 0; j--) {
      table[i][j] =
        beforeLines[i] === afterLines[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let beforeLine = 1;
  let afterLine = 1;
  while (i < beforeLines.length && j < afterLines.length) {
    if (beforeLines[i] === afterLines[j]) {
      lines.push({ kind: "same", text: beforeLines[i], beforeLine, afterLine });
      i++;
      j++;
      beforeLine++;
      afterLine++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push({ kind: "removed", text: beforeLines[i], beforeLine });
      i++;
      beforeLine++;
    } else {
      lines.push({ kind: "added", text: afterLines[j], afterLine });
      j++;
      afterLine++;
    }
  }
  for (; i < beforeLines.length; i++, beforeLine++) {
    lines.push({ kind: "removed", text: beforeLines[i], beforeLine });
  }
  for (; j < afterLines.length; j++, afterLine++) {
    lines.push({ kind: "added", text: afterLines[j], afterLine });
  }
  return { lines, truncated: false };
}

export function splitLines(value: string) {
  if (value.length === 0) return [];
  return value.split(/\r?\n/);
}
