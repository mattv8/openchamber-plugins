import type { KeyboardEvent } from 'react';
import { GitRefIcon } from './GitRefIcon.js';
import type { HistoryMode } from '../domain/controls.js';

const modes: HistoryMode[] = ['auto', 'all', 'manual'];

export function GitGraphControls({ mode, disabled, loading, onModeChange, onRefresh, t }: {
  mode: HistoryMode;
  disabled: boolean;
  loading: boolean;
  onModeChange(mode: HistoryMode): void;
  onRefresh(): void;
  t(key: string): string;
}) {
  const moveTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const direction = event.key === 'ArrowRight' || (event.ctrlKey && event.key.toLowerCase() === 'n') ? 1
      : event.key === 'ArrowLeft' || (event.ctrlKey && event.key.toLowerCase() === 'p') ? -1 : 0;
    if (!direction) return;
    event.preventDefault();
    const next = (index + direction + modes.length) % modes.length;
    onModeChange(modes[next]!);
    event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };

  return <div className="git-graph-controls" data-ui="git-graph-controls">
    <div role="tablist" aria-label={t('status.historyMode')} className="git-status-modes">
      {modes.map((item, index) => <button key={item} type="button" role="tab" disabled={disabled} tabIndex={mode === item ? 0 : -1} aria-selected={mode === item} onKeyDown={(event) => moveTab(event, index)} onClick={() => onModeChange(item)}>{t(`status.mode.${item}`)}</button>)}
    </div>
    <button type="button" className="git-graph-refresh" disabled={loading} onClick={onRefresh} aria-label={t('status.refresh')}><GitRefIcon name="refresh" className="git-ref-icon" /></button>
  </div>;
}
