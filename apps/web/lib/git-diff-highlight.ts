import { parser as javascriptParser } from "@lezer/javascript";
import { highlightTree, tags, tagHighlighter } from "@lezer/highlight";

const parser = javascriptParser.configure({ dialect: "jsx ts" });
const highlighter = tagHighlighter([
  { tag: tags.keyword, class: "text-violet-700 dark:text-violet-300" },
  { tag: [tags.string, tags.special(tags.string)], class: "text-amber-700 dark:text-amber-300" },
  { tag: [tags.number, tags.bool, tags.null], class: "text-blue-700 dark:text-blue-300" },
  { tag: tags.comment, class: "text-slate-600 dark:text-slate-400" },
  { tag: tags.definition(tags.variableName), class: "font-semibold" },
]);

/** Return inert text spans; never generate HTML from a patch. */
export function highlightGitDiffLine(path: string, line: string) {
  if (!/\.(?:[cm]?[jt]sx?)$/i.test(path) || !/^[ +\-]/.test(line) || line.length > 4096) return [{ text: line, className: "" }];
  const prefix = line[0]!; const code = line.slice(1); const spans: Array<{ text: string; className: string }> = [{ text: prefix, className: "" }];
  let offset = 0;
  highlightTree(parser.parse(code), highlighter, (from, to, classes) => {
    if (from > offset) spans.push({ text: code.slice(offset, from), className: "" });
    spans.push({ text: code.slice(from, to), className: classes }); offset = to;
  });
  if (offset < code.length) spans.push({ text: code.slice(offset), className: "" });
  return spans;
}
