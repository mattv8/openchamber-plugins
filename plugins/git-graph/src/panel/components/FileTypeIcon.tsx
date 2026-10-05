function language(path: string): string | null {
  const lower = path.toLowerCase();
  if (/\.(test|spec)\.tsx?$/.test(lower)) return 'TS';
  if (/\.tsx?$/.test(lower)) return 'TS';
  if (/\.(test|spec)\.jsx?$/.test(lower)) return 'JS';
  if (/\.jsx?$/.test(lower)) return 'JS';
  return null;
}

export function FileTypeIcon({ path }: { path: string }) {
  const label = language(path);
  const test = /\.(test|spec)\.[jt]sx?$/i.test(path);
  if (label) return <svg className="git-file-type-icon" viewBox="0 0 12 12" aria-hidden="true" role="presentation" style={{ color: test ? 'var(--oc-syntax-keyword, var(--git-graph-1))' : label === 'TS' ? 'var(--oc-syntax-type, var(--git-graph-3))' : 'var(--oc-syntax-string, var(--git-graph-4))' }}>
    <text x="6" y="9" fill="currentColor" fontFamily="var(--oc-mono, ui-monospace, monospace)" fontSize="9" fontWeight="600" textAnchor="middle">{label}</text>
  </svg>;
  return <svg className="git-file-type-icon" viewBox="0 0 12 12" aria-hidden="true" role="presentation" style={{ color: 'var(--oc-muted, GrayText)' }}>
    <path d="M2.25 1.25h4.5l2 2v7.5h-6.5z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
    <path d="M6.75 1.25v2h2" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
  </svg>;
}
