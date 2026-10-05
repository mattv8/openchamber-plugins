import type { GitHistoryGraphNode } from '../original/gitGraph.js';

const SWIMLANE_WIDTH = 11;

export function GraphContinuation({ outputSwimlanes, totalColumns }: { outputSwimlanes: readonly GitHistoryGraphNode[]; totalColumns: number }) {
  if (outputSwimlanes.length === 0) return null;
  const width = SWIMLANE_WIDTH * (totalColumns + 1);
  return <div className="git-file-graph-gutter" data-git-file-graph="true" aria-hidden="true">
    <svg width={width} viewBox={`0 0 ${width} 100`} preserveAspectRatio="none" role="presentation">
      {outputSwimlanes.map((lane, index) => <path key={lane.id} d={`M ${SWIMLANE_WIDTH * (index + 1)} 0 V 100`} fill="none" stroke={lane.color} strokeLinecap="round" strokeWidth="0.75" />)}
    </svg>
  </div>;
}
