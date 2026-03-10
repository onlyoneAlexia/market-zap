import { Skeleton } from "@/components/ui/skeleton";

export default function MarketDetailLoading() {
  return (
    <div className="container mx-auto max-w-screen-xl px-4 py-6">
      <div className="mb-6 space-y-3">
        <Skeleton className="h-8 w-3/4" />
        <div className="flex gap-2">
          <Skeleton className="h-5 w-16" />
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-5 w-20" />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="space-y-6">
          <Skeleton className="h-[260px] w-full rounded-lg" />
          <Skeleton className="h-[120px] w-full rounded-lg" />
          <Skeleton className="h-[200px] w-full rounded-lg" />
        </div>
        <div className="space-y-6">
          <Skeleton className="h-[420px] w-full rounded-lg" />
          <Skeleton className="h-[160px] w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}
