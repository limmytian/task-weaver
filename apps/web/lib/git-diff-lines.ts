export type DiffLine = { text: string; side?: 'old' | 'new'; line?: number };

/** Map unified diff lines to the original or delivered file line number. */
export function gitDiffLines(patch: string): DiffLine[] {
  let oldLine: number | undefined;
  let newLine: number | undefined;
  return patch.split('\n').map(text => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); return { text }; }
    if (oldLine === undefined || newLine === undefined || text.startsWith('\\') || text === '') return { text };
    if (text.startsWith('+')) return { text, side: 'new', line: newLine++ };
    if (text.startsWith('-')) return { text, side: 'old', line: oldLine++ };
    if (text.startsWith(' ')) { oldLine++; return { text, side: 'new', line: newLine++ }; }
    return { text };
  });
}
