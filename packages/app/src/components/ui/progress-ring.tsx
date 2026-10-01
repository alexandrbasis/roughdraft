import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

function ProgressRing({
  value,
  className,
  ...props
}: ComponentProps<"span"> & { value: number }) {
  const progress = Math.min(100, Math.max(0, value));

  return (
    <span
      data-slot="progress-ring"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress)}
      className={cn("inline-flex size-4 shrink-0 text-current", className)}
      {...props}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="size-full -rotate-90"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" className="opacity-15" />
        <circle
          data-slot="progress-ring-indicator"
          cx="12"
          cy="12"
          r="9"
          pathLength="100"
          strokeLinecap="round"
          strokeDasharray="100"
          strokeDashoffset={100 - progress}
          className="transition-[stroke-dashoffset] duration-100 ease-linear motion-reduce:transition-none"
        />
      </svg>
    </span>
  );
}

export { ProgressRing };
