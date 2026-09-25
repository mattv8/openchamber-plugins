import type { ComponentProps } from 'react';

type IconName = 'target' | 'git-branch' | 'cloud' | 'git-commit' | 'refresh';

export function GitRefIcon({ name, ...props }: { name: IconName } & ComponentProps<'svg'>) {
  const paths = {
    target: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></>,
    'git-branch': <><path d="M6 3v12a3 3 0 0 0 3 3h9" /><circle cx="6" cy="3" r="2" /><circle cx="18" cy="18" r="2" /><path d="M6 9h6a3 3 0 0 1 3 3v3" /></>,
    cloud: <path d="M7 18h10a4 4 0 0 0 .7-7.94A6 6 0 0 0 6.1 11.8 3.1 3.1 0 0 0 7 18Z" />,
    'git-commit': <><path d="M3 12h4M17 12h4" /><circle cx="12" cy="12" r="4" /></>,
    refresh: <><path d="M20 11a8 8 0 1 0 2 5" /><path d="M20 4v7h-7" /></>,
  }[name];

  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths}</svg>;
}
