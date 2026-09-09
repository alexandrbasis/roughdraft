import { ExternalLink, ImageOff } from "lucide-react";
import { createContext, useContext, useState } from "react";
import type { StorageBackend } from "./storage";

export const CommentAssetContext = createContext<StorageBackend | null>(null);
export const CommentUploadContext = createContext<{
  current: number;
} | null>(null);

export interface CommentImage {
  alt: string;
  path: string;
  markdown: string;
  start: number;
  end: number;
}

// Comments stay plain text except for Markdown images. Never interpret raw HTML.
export function parseCommentImages(content: string): CommentImage[] {
  return Array.from(
    content.matchAll(/!\[([^\]\n]*)\]\(([^\s)]+)\)/g),
    (match) => ({
      alt: match[1] || "Screenshot",
      path: match[2],
      markdown: match[0],
      start: match.index,
      end: match.index + match[0].length,
    }),
  );
}

function safeImageUrl(path: string, backend: StorageBackend | null) {
  if (
    /^[\s\\]/.test(path) ||
    Array.from(path).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return null;
  const isWebUrl = /^https?:\/\//i.test(path);
  if (
    !isWebUrl &&
    (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith("//"))
  ) {
    return null;
  }
  const url = isWebUrl ? path : backend?.resolveFileUrl(path);
  if (!url) return null;
  if (
    /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z\d+/=]+$/i.test(url)
  ) {
    return url;
  }
  try {
    const parsed = new URL(url, window.location.href);
    return ["http:", "https:", "blob:"].includes(parsed.protocol) ? url : null;
  } catch {
    return null;
  }
}

export function CommentImagePreview({
  image,
  backend: explicitBackend,
}: {
  image: CommentImage;
  backend?: StorageBackend | null;
}) {
  const contextBackend = useContext(CommentAssetContext);
  const backend =
    explicitBackend === undefined ? contextBackend : explicitBackend;
  const url = safeImageUrl(image.path, backend);
  const [failed, setFailed] = useState(false);
  if (!url) return <span className="break-all">{image.markdown}</span>;

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open image: ${image.alt}`}
      className="my-2 block max-w-full overflow-hidden rounded-lg border border-border bg-muted/30 text-foreground no-underline transition-colors hover:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={(event) => event.stopPropagation()}
    >
      {failed ? (
        <span className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
          <ImageOff className="size-4 shrink-0" />
          Preview unavailable
        </span>
      ) : (
        <img
          data-testid="comment-image"
          data-markdown-src={image.path}
          src={url}
          alt={image.alt}
          loading="lazy"
          className="max-h-48 w-full object-contain"
          onError={() => setFailed(true)}
        />
      )}
      <span className="flex min-w-0 items-center gap-2 border-t border-border px-2.5 py-1.5 text-[11px] leading-4 whitespace-normal text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{image.alt}</span>
        <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
      </span>
    </a>
  );
}

export function CommentBody({ content }: { content: string }) {
  const images = parseCommentImages(content);
  if (images.length === 0) return <>{content}</>;
  let cursor = 0;
  const parts = images.map((image) => {
    const text = content.slice(cursor, image.start);
    cursor = image.end;
    return (
      <span key={`${image.start}:${image.path}`}>
        {text}
        <CommentImagePreview image={image} />
      </span>
    );
  });
  return (
    <>
      {parts}
      {content.slice(cursor)}
    </>
  );
}
