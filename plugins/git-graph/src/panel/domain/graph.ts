/**
 * Graph layout adapted from VS Code SCM history (MIT). It is intentionally
 * data-only so the opaque iframe never needs a host graph implementation.
 */
export type GraphRef = { id: string; name: string; revision: string | null; kind: 'head' | 'local' | 'remote' | 'tag'; category: 'branches' | 'remote-branches' | 'tags' };
export type GraphCommit = { id: string; parentIds: string[]; subject: string; message: string; author: string; authorEmail: string; timestamp: string; statistics: { files: number; insertions: number; deletions: number }; references: GraphRef[] };
export type Lane = { id: string; color: string };
export type GraphRow = { commit: GraphCommit; input: Lane[]; output: Lane[]; column: number; color: string; kind: 'head' | 'commit' };

const colors = ['var(--oc-primary, Highlight)', 'var(--oc-success, CanvasText)', 'var(--oc-warning, CanvasText)', 'var(--oc-error, CanvasText)', 'var(--oc-muted, GrayText)'];
const clone = (lane: Lane): Lane => ({ ...lane });
const hash = (value: string): number => {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  return result >>> 0;
};

export function buildGraph(commits: readonly GraphCommit[], head: GraphRef | null): GraphRow[] {
  const assigned = new Map<string, string>();
  const color = (id: string, unavailable: readonly string[] = []): string => {
    const existing = assigned.get(id);
    if (existing) return existing;
    const start = hash(id) % colors.length;
    const next = colors.find((candidate, index) => !unavailable.includes(candidate) && index >= start) ?? colors[start]!;
    assigned.set(id, next);
    return next;
  };
  if (head) color(head.id);
  const rows: GraphRow[] = [];
  for (const commit of commits) {
    const input = (rows.at(-1)?.output ?? []).map(clone);
    const existingColumn = input.findIndex((lane) => lane.id === commit.id);
    const column = existingColumn === -1 ? input.length : existingColumn;
    const ref = commit.references.find((item) => item.category !== 'tags');
    const nodeColor = ref ? color(ref.id, input.map((lane) => lane.color)) : color(commit.id, input.map((lane) => lane.color));
    const output: Lane[] = [];
    let firstParent = false;
    for (const lane of input) {
      if (lane.id !== commit.id) output.push(clone(lane));
      else if (commit.parentIds[0]) {
        output.push({ id: commit.parentIds[0], color: nodeColor });
        firstParent = true;
      }
    }
    for (let index = firstParent ? 1 : 0; index < commit.parentIds.length; index += 1) {
      const parent = commit.parentIds[index]!;
      output.push({ id: parent, color: color(parent, output.map((lane) => lane.color)) });
    }
    rows.push({ commit, input, output, column, color: nodeColor, kind: commit.id === head?.revision ? 'head' : 'commit' });
  }
  return rows;
}

export function refBadges(refs: readonly GraphRef[]): { primary: GraphRef | null; secondary: GraphRef[] } {
  const visible = refs.some((ref) => ref.kind !== 'tag') ? refs.filter((ref) => ref.kind !== 'tag') : refs;
  return { primary: visible[0] ?? null, secondary: visible.slice(1) };
}
