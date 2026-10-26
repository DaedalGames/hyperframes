const CONTEXT = 3;
// Past this many changed lines Myers' trace grows quadratically; the middle is then shown as one replace.
const MAX_EDIT_LINES = 4000;

type Op = { kind: " " | "-" | "+"; text: string };

/** Lines of `text` with a marker on a last line that has no newline, so "A" and "A\n" differ as in git. */
function linesOf(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  else lines[lines.length - 1] += "\0";
  return lines;
}

const display = (line: string): string =>
  line.endsWith("\0") ? `${line.slice(0, -1)}\n\\ No newline at end of file` : line;

/** Edit script turning `a` into `b` (Myers), after the shared head and tail are set aside. */
function editScript(a: string[], b: string[]): Op[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  const same = (lines: string[]): Op[] => lines.map((text) => ({ kind: " ", text }));
  return [...same(a.slice(0, head)), ...middle(x, y), ...same(a.slice(a.length - tail))];
}

function middle(a: string[], b: string[]): Op[] {
  const replace = (): Op[] => [
    ...a.map((text): Op => ({ kind: "-", text })),
    ...b.map((text): Op => ({ kind: "+", text })),
  ];
  const n = a.length;
  const m = b.length;
  if (n + m === 0) return [];
  if (n + m > MAX_EDIT_LINES) return replace();
  const offset = n + m;
  const v = new Int32Array(2 * offset + 2);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= offset; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let px = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
        ? v[offset + k + 1]!
        : v[offset + k - 1]! + 1;
      let py = px - k;
      while (px < n && py < m && a[px] === b[py]) (px++, py++);
      v[offset + k] = px;
      if (px >= n && py >= m) return backtrack(trace, a, b, offset, d);
    }
  }
  return replace();
}

function backtrack(trace: Int32Array[], a: string[], b: string[], offset: number, last: number) {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = last; d > 0; d--) {
    const v = trace[d]!;
    const k = x - y;
    const down = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!);
    const prevK = down ? k + 1 : k - 1;
    const prevX = v[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > (down ? prevX : prevX + 1) && y > (down ? prevY + 1 : prevY)) {
      ops.push({ kind: " ", text: a[--x]! });
      y--;
    }
    if (down) ops.push({ kind: "+", text: b[--y]! });
    else ops.push({ kind: "-", text: a[--x]! });
  }
  while (x > 0) {
    ops.push({ kind: " ", text: a[--x]! });
    y--;
  }
  return ops.reverse();
}

/** A git-style unified diff of one text file, `after` empty for a deleted file and `before` empty for an added one. */
export function unifiedDiff(path: string, before: string, after: string): string {
  const ops = editScript(linesOf(before), linesOf(after));
  const changed = ops.flatMap((op, index) => (op.kind === " " ? [] : [index]));
  if (changed.length === 0) return "";
  const out = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
  let from = 0;
  while (from < changed.length) {
    let to = from;
    while (to + 1 < changed.length && changed[to + 1]! - changed[to]! <= 2 * CONTEXT + 1) to++;
    const start = Math.max(0, changed[from]! - CONTEXT);
    const end = Math.min(ops.length, changed[to]! + CONTEXT + 1);
    const hunk = ops.slice(start, end);
    const before0 = ops.slice(0, start).filter((op) => op.kind !== "+").length;
    const after0 = ops.slice(0, start).filter((op) => op.kind !== "-").length;
    const oldLen = hunk.filter((op) => op.kind !== "+").length;
    const newLen = hunk.filter((op) => op.kind !== "-").length;
    const range = (first: number, length: number) =>
      length === 1 ? `${first + 1}` : `${length === 0 ? first : first + 1},${length}`;
    out.push(`@@ -${range(before0, oldLen)} +${range(after0, newLen)} @@`);
    for (const op of hunk) out.push(`${op.kind}${display(op.text)}`);
    from = to + 1;
  }
  return out.join("\n");
}
