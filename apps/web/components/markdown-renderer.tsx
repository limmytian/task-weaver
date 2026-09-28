"use client";

import { useEffect, useId, useRef, memo, type ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useRouter } from "next/navigation";
import { trpc } from "@/trpc/client";

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

export function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  const wikiLinkTitles = extractWikiLinkTitles(content);
  const { data: resolved } = trpc.document.resolveWikiLinks.useQuery(
    { titles: wikiLinkTitles },
    { enabled: wikiLinkTitles.length > 0 },
  );
  const titleToId = new Map(resolved?.map((d) => [d.title, d.id]) ?? []);

  const preprocessed = preprocessWikiLinks(content, titleToId);

  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: CodeBlockRenderer,
          a: WikiLinkAwareLink,
        }}
      >
        {preprocessed}
      </ReactMarkdown>
    </div>
  );
}

const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

function extractWikiLinkTitles(content: string): string[] {
  const titles: string[] = [];
  let match: RegExpExecArray | null;
  WIKI_LINK_RE.lastIndex = 0;
  while ((match = WIKI_LINK_RE.exec(content)) !== null) {
    titles.push(match[1]!.trim());
  }
  return [...new Set(titles)];
}

function preprocessWikiLinks(
  content: string,
  titleToId: Map<string, string>,
): string {
  return content.replace(WIKI_LINK_RE, (_match, title: string, display?: string) => {
    const trimTitle = title.trim();
    const label = display?.trim() ?? trimTitle;
    const docId = titleToId.get(trimTitle);
    if (docId) {
      return `[${label}](/projects/documents/${docId} "wikilink::${trimTitle}")`;
    }
    return `[${label}](#not-found "wikilink-missing::${trimTitle}")`;
  });
}

function WikiLinkAwareLink({
  href,
  title,
  children,
  ...props
}: ComponentProps<"a">) {
  const router = useRouter();

  if (title?.startsWith("wikilink::")) {
    const docTitle = title.slice("wikilink::".length);
    return (
      <a
        {...props}
        href={href}
        className="font-medium text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary cursor-pointer"
        title={`Go to "${docTitle}"`}
        onClick={(e) => {
          e.preventDefault();
          if (href) router.push(href);
        }}
      >
        {children}
      </a>
    );
  }

  if (title?.startsWith("wikilink-missing::")) {
    const docTitle = title.slice("wikilink-missing::".length);
    return (
      <span
        className="font-medium text-primary/60 underline decoration-primary/20 underline-offset-2 cursor-default"
        title={`Document "${docTitle}" not found`}
      >
        {children}
      </span>
    );
  }

  return (
    <a href={href} title={title} target="_blank" rel="noopener noreferrer" {...props}>
      {children}
    </a>
  );
}

function CodeBlockRenderer({
  className,
  children,
  ...props
}: ComponentProps<"code">) {
  const lang = className?.replace("language-", "");
  const codeStr = String(children).replace(/\n$/, "");

  if (lang === "mermaid") {
    return <MermaidBlock chart={codeStr} />;
  }

  if (!className) {
    return (
      <code
        className="rounded bg-muted px-1.5 py-0.5 text-sm font-mono"
        {...props}
      >
        {children}
      </code>
    );
  }

  return (
    <code className={`${className} text-sm`} {...props}>
      {children}
    </code>
  );
}

const MermaidBlock = memo(function MermaidBlock({ chart }: { chart: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const uniqueId = useId().replace(/:/g, "_");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const mermaid = (await import("mermaid")).default;
      mermaid.initialize({
        startOnLoad: false,
        theme: "default",
        securityLevel: "loose",
      });
      if (cancelled || !containerRef.current) return;
      try {
        const { svg } = await mermaid.render(`mermaid_${uniqueId}`, chart);
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg;
        }
      } catch {
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = `<pre class="text-destructive text-sm p-2">Mermaid diagram parse error</pre>`;
        }
      }
    })();
    return () => { cancelled = true; };
  }, [chart, uniqueId]);

  return (
    <div
      ref={containerRef}
      className="my-4 flex justify-center overflow-x-auto [&>svg]:max-w-full"
    />
  );
});
