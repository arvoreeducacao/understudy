export const WORKSPACE_TABS = ["computer", "files", "terminal", "jobs", "memory", "tasks", "logins", "settings"] as const;

export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

const SHARED_TABS: readonly WorkspaceTab[] = ["computer", "tasks"];

export const DEFAULT_TAB: WorkspaceTab = "computer";

export function tabsFor(owner: boolean): readonly WorkspaceTab[] {
  return owner ? WORKSPACE_TABS : SHARED_TABS;
}

export const ADVANCED_TABS: readonly WorkspaceTab[] = ["terminal"];

export function barTabs(owner: boolean, current: WorkspaceTab): readonly WorkspaceTab[] {
  return tabsFor(owner).filter((tab) => tab === current || !ADVANCED_TABS.includes(tab));
}

export function advancedTabs(owner: boolean): readonly WorkspaceTab[] {
  return tabsFor(owner).filter((tab) => ADVANCED_TABS.includes(tab));
}

export function parseTab(value: string | null | undefined, owner: boolean): WorkspaceTab {
  const tabs = tabsFor(owner);
  return tabs.find((tab) => tab === value) ?? DEFAULT_TAB;
}

export function tabSearch(current: string, tab: WorkspaceTab) {
  const params = new URLSearchParams(current);
  if (tab === DEFAULT_TAB) params.delete("tab");
  else params.set("tab", tab);
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function agentTabPath(agentId: string, tab: WorkspaceTab) {
  return `/agents/${agentId}${tabSearch("", tab)}`;
}
