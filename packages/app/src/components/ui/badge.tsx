import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

function Badge({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="badge"
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-1 rounded-md border border-transparent bg-secondary px-2 py-0.5 text-xs font-medium whitespace-nowrap text-secondary-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30",
        className,
      )}
      {...props}
    />
  );
}

export { Badge };
