import { ImagePlus, Loader2, X } from "lucide-react";
import {
  type ComponentProps,
  forwardRef,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  CommentAssetContext,
  CommentImagePreview,
  CommentUploadContext,
  parseCommentImages,
} from "./CommentBody";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import type { StorageBackend } from "./storage";

const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

type CommentComposerProps = Omit<
  ComponentProps<typeof Textarea>,
  "value" | "onChange"
> & {
  "data-testid"?: string;
  value: string;
  onChange: (value: string) => void;
  backend?: StorageBackend | null;
  onUploadingChange?: (uploading: boolean) => void;
};

export const CommentComposer = forwardRef<
  HTMLTextAreaElement,
  CommentComposerProps
>(function CommentComposer(
  {
    value,
    onChange,
    backend: explicitBackend,
    onUploadingChange,
    onPaste,
    onKeyDown,
    disabled,
    ...props
  },
  ref,
) {
  const contextBackend = useContext(CommentAssetContext);
  const uploadCount = useContext(CommentUploadContext);
  const backend =
    explicitBackend === undefined ? contextBackend : explicitBackend;
  const canAttach = !!backend && backend.info.kind !== "remote";
  const fileInput = useRef<HTMLInputElement>(null);
  const currentValue = useRef(value);
  currentValue.current = value;
  const currentOnChange = useRef(onChange);
  currentOnChange.current = onChange;
  const mounted = useRef(true);
  const busy = useRef(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const images = parseCommentImages(value);
  const testId = props["data-testid"] ?? "comment-composer";

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function updateValue(next: string) {
    currentValue.current = next;
    currentOnChange.current(next);
  }

  async function attachFiles(files: File[]) {
    if (
      busy.current ||
      disabled ||
      !canAttach ||
      !backend ||
      files.length === 0
    )
      return;
    setError(null);
    busy.current = true;
    if (uploadCount) uploadCount.current += 1;
    setUploading(true);
    onUploadingChange?.(true);
    try {
      for (const file of files) {
        if (!IMAGE_TYPES.has(file.type)) {
          throw new Error("Choose a PNG, JPEG, GIF, WebP or AVIF image.");
        }
        if (file.size > MAX_IMAGE_BYTES) {
          throw new Error("Choose an image smaller than 10 MB.");
        }
        const asset = await backend.saveAsset(file).catch(() => {
          throw new Error(
            "The image could not be attached. Your text is still here. Try again.",
          );
        });
        if (!mounted.current) return;
        const alt = (file.name || "Screenshot").replace(/[[\]\\\r\n]/g, " ");
        const markdown = `![${alt}](${asset.markdownPath})`;
        const next = `${currentValue.current}${currentValue.current.trim() ? "\n\n" : ""}${markdown}`;
        if (props.maxLength && next.length > props.maxLength) {
          throw new Error(
            "The comment is too long. Shorten the text and attach the image again.",
          );
        }
        updateValue(next);
      }
    } catch (cause) {
      if (mounted.current) {
        setError(
          cause instanceof Error
            ? cause.message
            : "The image could not be attached. Try again.",
        );
      }
    } finally {
      busy.current = false;
      if (uploadCount) uploadCount.current -= 1;
      if (mounted.current) setUploading(false);
      onUploadingChange?.(false);
    }
  }

  return (
    <div data-comment-uploading={uploading ? "true" : undefined}>
      <Textarea
        {...props}
        ref={ref}
        disabled={disabled}
        value={value}
        onChange={(event) => updateValue(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (
            busy.current &&
            (event.key === "Escape" ||
              ((event.metaKey || event.ctrlKey) && event.key === "Enter"))
          ) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          onKeyDown?.(event);
        }}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.items)
            .filter(
              (item) => item.kind === "file" && item.type.startsWith("image/"),
            )
            .map((item) => item.getAsFile())
            .filter((file): file is File => file !== null);
          if (files.length === 0) {
            onPaste?.(event);
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          if (!canAttach) {
            setError("Image attachments are available in local reviews.");
            return;
          }
          void attachFiles(files);
        }}
      />
      {images.length > 0 ? (
        <div className="mt-2 space-y-1">
          {images.map((image) => (
            <div key={`${image.start}:${image.path}`} className="relative pr-7">
              <CommentImagePreview image={image} backend={backend} />
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="absolute top-1 right-0 text-muted-foreground"
                data-testid="comment-image-remove"
                aria-label={`Remove image: ${image.alt}`}
                disabled={disabled || uploading}
                onClick={(event) => {
                  event.stopPropagation();
                  updateValue(
                    value.slice(0, image.start) + value.slice(image.end),
                  );
                }}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        {canAttach ? (
          <>
            <input
              ref={fileInput}
              data-testid={`${testId}-file-input`}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
              multiple
              hidden
              aria-label="Choose images"
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? []);
                event.currentTarget.value = "";
                void attachFiles(files);
              }}
            />
            <Button
              type="button"
              data-testid={`${testId}-attach`}
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 px-1.5 text-xs text-muted-foreground hover:text-foreground"
              disabled={disabled || uploading}
              onClick={(event) => {
                event.stopPropagation();
                fileInput.current?.click();
              }}
            >
              {uploading ? (
                <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
              ) : (
                <ImagePlus aria-hidden="true" className="size-3.5" />
              )}
              {uploading ? "Attaching…" : "Attach image"}
            </Button>
            <span
              role="status"
              data-testid={`${testId}-upload-status`}
              className="text-[11px] leading-4 text-muted-foreground"
            >
              {uploading ? "You can keep typing" : "or paste a screenshot"}
            </span>
          </>
        ) : backend?.info.kind === "remote" ? (
          <span className="text-[11px] leading-4 text-muted-foreground">
            Image attachments are available in local reviews.
          </span>
        ) : null}
      </div>
      {error ? (
        <p
          role="alert"
          data-testid={`${testId}-upload-error`}
          className="mt-1.5 text-xs leading-4 text-destructive"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
});
