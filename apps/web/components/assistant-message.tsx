"use client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
/** Render model Markdown without raw HTML, remote image loading or unsafe links. */
export function AssistantMessageContent({ content }: { content: string }) {
  return <div className="min-w-0 space-y-3 break-words [&_a]:text-primary [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_code]:break-all [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:ml-4 [&_ol]:list-decimal [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-background/70 [&_pre]:p-3 [&_table]:block [&_table]:overflow-x-auto [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:p-2 [&_ul]:list-disc">
    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
      a: ({ children, href }) => <a href={href} target={href?.startsWith("http") ? "_blank" : undefined} rel="noopener noreferrer">{children}</a>,
      img: ({ alt }) => <span className="text-muted-foreground">{alt ? `[Image: ${alt}]` : "[Image]"}</span>,
    }}>{content}</ReactMarkdown>
  </div>;
}
