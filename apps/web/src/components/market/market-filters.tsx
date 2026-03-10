"use client";

import { cn } from "@/lib/utils";

const categories = [
  { id: "all", label: "All" },
  { id: "crypto", label: "Crypto" },
  { id: "politics", label: "Politics" },
  { id: "sports", label: "Sports" },
  { id: "culture", label: "Culture" },
  { id: "science", label: "Science" },
] as const;

const sortOptions = [
  { id: "trending", label: "Trending" },
  { id: "volume", label: "Volume" },
  { id: "newest", label: "Newest" },
  { id: "ending-soon", label: "Ending Soon" },
] as const;

const marketTypeOptions = [
  { id: "all", label: "All" },
  { id: "public", label: "Public" },
  { id: "private", label: "Dark" },
] as const;

interface MarketFiltersProps {
  selectedCategory: string;
  onCategoryChange: (category: string) => void;
  selectedSort: string;
  onSortChange: (sort: string) => void;
  selectedMarketType?: string;
  onMarketTypeChange?: (type: string) => void;
}

function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "shrink-0 rounded px-2.5 py-1 text-[11px] font-mono font-bold tracking-wider transition-all duration-snappy ease-snappy",
        active
          ? "bg-primary/15 text-primary border border-primary/30"
          : "text-muted-foreground border border-transparent hover:text-foreground hover:border-border"
      )}
    >
      {children}
    </button>
  );
}

export function MarketFilters({
  selectedCategory,
  onCategoryChange,
  selectedSort,
  onSortChange,
  selectedMarketType = "all",
  onMarketTypeChange,
}: MarketFiltersProps) {
  return (
    <div className="-mx-1 flex flex-wrap items-center gap-x-0.5 gap-y-1.5 overflow-x-auto px-1">
      {categories.map((cat) => (
        <Pill
          key={cat.id}
          active={selectedCategory === cat.id}
          onClick={() => onCategoryChange(cat.id)}
        >
          {cat.label}
        </Pill>
      ))}

      <div className="mx-1.5 h-3.5 w-px bg-border" />

      {sortOptions.map((sort) => (
        <Pill
          key={sort.id}
          active={selectedSort === sort.id}
          onClick={() => onSortChange(sort.id)}
        >
          {sort.label}
        </Pill>
      ))}

      {onMarketTypeChange && (
        <>
          <div className="mx-1.5 h-3.5 w-px bg-border" />
          {marketTypeOptions.map((opt) => (
            <Pill
              key={opt.id}
              active={selectedMarketType === opt.id}
              onClick={() => onMarketTypeChange(opt.id)}
            >
              {opt.label}
            </Pill>
          ))}
        </>
      )}
    </div>
  );
}
