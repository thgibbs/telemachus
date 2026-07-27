import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";

marked.setOptions({ gfm: true, breaks: true });

export function Markdown({
  children,
  className = "",
}: {
  children: string;
  className?: string;
}) {
  const html = useMemo(() => {
    const rendered = marked.parse(children || "", { async: false }) as string;
    return DOMPurify.sanitize(rendered, {
      ALLOWED_TAGS: [
        "p",
        "br",
        "strong",
        "em",
        "code",
        "pre",
        "ul",
        "ol",
        "li",
        "a",
        "blockquote",
        "h1",
        "h2",
        "h3",
        "hr",
      ],
      ALLOWED_ATTR: ["href", "title"],
      ALLOW_DATA_ATTR: false,
    });
  }, [children]);

  return (
    <div
      className={`markdown ${className}`}
      onClick={(event) => {
        const anchor = (event.target as HTMLElement).closest("a");
        if (!anchor) return;
        event.preventDefault();
        navigator.clipboard.writeText(anchor.href).catch(() => undefined);
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
