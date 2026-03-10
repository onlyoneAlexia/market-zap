const ACCOUNT_TABS = [
  "positions",
  "orders",
  "history",
  "rewards",
  "funds",
] as const;

export type AccountTab = (typeof ACCOUNT_TABS)[number];

export function isAccountTab(value: string | null): value is AccountTab {
  return ACCOUNT_TABS.includes(value as AccountTab);
}

export function getInitialAccountTab(
  params: URLSearchParams,
  fallback: AccountTab = "positions",
): AccountTab {
  const tab = params.get("tab");
  return isAccountTab(tab) ? tab : fallback;
}

export function replaceAccountTabInCurrentUrl(tab: AccountTab): void {
  const url = new URL(window.location.href);
  url.searchParams.set("tab", tab);
  window.history.replaceState(window.history.state, "", url);
}
