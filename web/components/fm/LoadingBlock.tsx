import { Skeleton } from "@/components/ui/skeleton";

/** Skeleton rows the size of the content they stand in for (WEBSITE §4 State). */
export function LoadingBlock({ rows = 3, label = "Loading" }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-label={label} className="grid gap-3" data-testid="loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-16 w-full rounded-lg" />
      ))}
    </div>
  );
}
