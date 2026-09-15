import ReactMarkdown from "react-markdown";

/** Model output is untrusted. Images become links, so viewing a result makes no remote image requests. */
export function safeResultUrl(value: string): string {
  if (/^(https?:\/\/)/i.test(value)) return value;
  if (/^(\/[^/]|#)/.test(value) && !/[\u0000-\u0020\\]/.test(value))
    return value;
  return "";
}

export function ResultMarkdown({ text }: { text: string }) {
  return (
    <div className="result-markdown">
      <ReactMarkdown
        skipHtml
        urlTransform={safeResultUrl}
        components={{
          a: ({ href, children }) =>
            href ? (
              <a
                href={href}
                target={href.startsWith("http") ? "_blank" : undefined}
                rel="noreferrer noopener"
              >
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          img: ({ src, alt }) =>
            typeof src === "string" && src ? (
              <a href={src} target="_blank" rel="noreferrer noopener">
                {alt || "Open image"}
              </a>
            ) : (
              <span>{alt || "Image omitted"}</span>
            ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
