"use client";

import { useCallback, useMemo, useState, useRef } from "react";
import CodeMirror, {
  type ReactCodeMirrorRef,
} from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  List,
  ListOrdered,
  Heading1,
  Heading2,
  Heading3,
  Quote,
  Minus,
  Link as LinkIcon,
  Eye,
  Pencil,
  Columns2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MarkdownRenderer } from "./markdown-renderer";
import { trpc } from "@/trpc/client";
import { cn } from "@/lib/utils";

type ViewMode = "edit" | "preview" | "split";

interface MarkdownEditorProps {
  content: string;
  onChange: (content: string) => void;
  placeholder?: string;
  editable?: boolean;
  projectId?: string;
  minHeight?: string;
}

export function MarkdownEditor({
  content,
  onChange,
  placeholder = "Start writing Markdown... (type [[ for wiki-links)",
  editable = true,
  projectId,
  minHeight = "200px",
}: MarkdownEditorProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("edit");
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const utils = trpc.useUtils();

  const wikiLinkCompletion = useCallback(
    async (context: CompletionContext): Promise<CompletionResult | null> => {
      const before = context.matchBefore(/\[\[[^\]]*$/);
      if (!before) return null;

      const query = before.text.slice(2);

      try {
        let items: Array<{ id: string; title: string }> = [];
        if (query.length > 0) {
          const results = await utils.document.search.fetch({
            query,
            mode: "keyword",
            projectId,
            includeGlobal: true,
            limit: 10,
          });
          items = results.map((r) => ({
            id: r.id,
            title: r.title,
          }));
        } else {
          const docs = await utils.document.list.fetch({
            projectId,
            includeGlobal: true,
          });
          items = docs.slice(0, 10).map((d) => ({
            id: d.id,
            title: d.title,
          }));
        }
        return {
          from: before.from,
          options: items.map((item) => ({
            label: item.title,
            apply: `[[${item.title}]]`,
            type: "text",
          })),
          filter: false,
        };
      } catch {
        return null;
      }
    },
    [utils, projectId],
  );

  const extensions = useMemo(
    () => [
      markdown(),
      EditorView.lineWrapping,
      autocompletion({
        override: [wikiLinkCompletion],
        activateOnTyping: true,
      }),
      EditorView.theme({
        "&": { minHeight },
        ".cm-scroller": { minHeight },
        ".cm-content": { padding: "12px 16px" },
      }),
    ],
    [wikiLinkCompletion, minHeight],
  );

  const insertMarkdown = useCallback(
    (before: string, after: string = "") => {
      const view = editorRef.current?.view;
      if (!view) return;
      const { from, to } = view.state.selection.main;
      const selected = view.state.sliceDoc(from, to);
      const replacement = `${before}${selected}${after}`;
      view.dispatch({
        changes: { from, to, insert: replacement },
        selection: {
          anchor: from + before.length,
          head: from + before.length + selected.length,
        },
      });
      view.focus();
    },
    [],
  );

  const insertLine = useCallback(
    (prefix: string) => {
      const view = editorRef.current?.view;
      if (!view) return;
      const { from } = view.state.selection.main;
      const line = view.state.doc.lineAt(from);
      const lineText = line.text;
      if (lineText.startsWith(prefix)) {
        view.dispatch({
          changes: { from: line.from, to: line.from + prefix.length, insert: "" },
        });
      } else {
        view.dispatch({
          changes: { from: line.from, insert: prefix },
        });
      }
      view.focus();
    },
    [],
  );

  if (!editable) {
    return (
      <div className="prose prose-neutral dark:prose-invert prose-sm max-w-none">
        <MarkdownRenderer content={content} />
      </div>
    );
  }

  return (
    <div className="rounded-md border">
      <div className="flex flex-col gap-2 border-b px-2 py-1.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="scrollbar-none -mx-2 flex items-center gap-0.5 overflow-x-auto px-2">
          <ToolbarBtn
            icon={<Heading1 className="h-4 w-4" />}
            onClick={() => insertLine("# ")}
            title="Heading 1"
          />
          <ToolbarBtn
            icon={<Heading2 className="h-4 w-4" />}
            onClick={() => insertLine("## ")}
            title="Heading 2"
          />
          <ToolbarBtn
            icon={<Heading3 className="h-4 w-4" />}
            onClick={() => insertLine("### ")}
            title="Heading 3"
          />
          <Separator orientation="vertical" className="mx-1 h-5" />
          <ToolbarBtn
            icon={<Bold className="h-4 w-4" />}
            onClick={() => insertMarkdown("**", "**")}
            title="Bold"
          />
          <ToolbarBtn
            icon={<Italic className="h-4 w-4" />}
            onClick={() => insertMarkdown("*", "*")}
            title="Italic"
          />
          <ToolbarBtn
            icon={<Strikethrough className="h-4 w-4" />}
            onClick={() => insertMarkdown("~~", "~~")}
            title="Strikethrough"
          />
          <ToolbarBtn
            icon={<Code className="h-4 w-4" />}
            onClick={() => insertMarkdown("`", "`")}
            title="Inline Code"
          />
          <Separator orientation="vertical" className="mx-1 h-5" />
          <ToolbarBtn
            icon={<List className="h-4 w-4" />}
            onClick={() => insertLine("- ")}
            title="Bullet List"
          />
          <ToolbarBtn
            icon={<ListOrdered className="h-4 w-4" />}
            onClick={() => insertLine("1. ")}
            title="Ordered List"
          />
          <ToolbarBtn
            icon={<Quote className="h-4 w-4" />}
            onClick={() => insertLine("> ")}
            title="Blockquote"
          />
          <ToolbarBtn
            icon={<Minus className="h-4 w-4" />}
            onClick={() => insertMarkdown("\n---\n")}
            title="Horizontal Rule"
          />
          <ToolbarBtn
            icon={<LinkIcon className="h-4 w-4" />}
            onClick={() => insertMarkdown("[", "](url)")}
            title="Link"
          />
        </div>

        <Tabs
          value={viewMode}
          onValueChange={(v) => setViewMode(v as ViewMode)}
        >
          <TabsList className="grid h-10 w-full grid-cols-3 sm:h-7 sm:w-auto">
            <TabsTrigger value="edit" className="h-9 gap-1 px-2 text-xs sm:h-6">
              <Pencil className="h-3 w-3" />
              Edit
            </TabsTrigger>
            <TabsTrigger value="preview" className="h-9 gap-1 px-2 text-xs sm:h-6">
              <Eye className="h-3 w-3" />
              Preview
            </TabsTrigger>
            <TabsTrigger value="split" className="h-9 gap-1 px-2 text-xs sm:h-6">
              <Columns2 className="h-3 w-3" />
              Split
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {viewMode === "edit" && (
        <CodeMirror
          ref={editorRef}
          value={content}
          onChange={onChange}
          extensions={extensions}
          placeholder={placeholder}
          basicSetup={{
            lineNumbers: false,
            foldGutter: false,
            highlightActiveLine: true,
            bracketMatching: true,
            indentOnInput: true,
          }}
          className="text-sm"
        />
      )}

      {viewMode === "preview" && (
        <div
          className="prose prose-neutral dark:prose-invert prose-sm max-w-none px-4 py-3"
          style={{ minHeight }}
        >
          {content ? (
            <MarkdownRenderer content={content} />
          ) : (
            <p className="text-muted-foreground italic">{placeholder}</p>
          )}
        </div>
      )}

      {viewMode === "split" && (
        <div className="grid grid-cols-1 divide-y md:grid-cols-2 md:divide-x md:divide-y-0" style={{ minHeight }}>
          <CodeMirror
            ref={editorRef}
            value={content}
            onChange={onChange}
            extensions={extensions}
            placeholder={placeholder}
            basicSetup={{
              lineNumbers: false,
              foldGutter: false,
              highlightActiveLine: true,
              bracketMatching: true,
              indentOnInput: true,
            }}
            className="text-sm"
          />
          <div className="prose prose-neutral dark:prose-invert prose-sm max-w-none overflow-auto px-4 py-3">
            {content ? (
              <MarkdownRenderer content={content} />
            ) : (
              <p className="text-muted-foreground italic">{placeholder}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ToolbarBtn({
  onClick,
  active,
  disabled,
  icon,
  title,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  icon: React.ReactNode;
  title?: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn("size-10 p-0 sm:size-7", active && "bg-muted")}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {icon}
    </Button>
  );
}
