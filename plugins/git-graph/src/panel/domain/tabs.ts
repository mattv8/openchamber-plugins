export type DiffTab = { id: string; title: string; kind: 'working' | 'commit' | 'range'; path: string | null; scope: 'staged' | 'unstaged' | null; commit: string | null; parent: string | null; originalPath: string | null; modifiedPath: string | null };
export type TabState = { tabs: DiffTab[]; activeId: string | null };
export const emptyTabs = (): TabState => ({ tabs: [], activeId: null });
export function openTab(state: TabState, tab: DiffTab): TabState {
  const tabs = state.tabs.some((item) => item.id === tab.id) ? state.tabs.map((item) => item.id === tab.id ? tab : item) : [...state.tabs, tab].slice(-12);
  return { tabs, activeId: tab.id };
}
export function closeTab(state: TabState, id: string): TabState {
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  return { tabs, activeId: state.activeId === id ? (tabs.at(-1)?.id ?? null) : state.activeId };
}
