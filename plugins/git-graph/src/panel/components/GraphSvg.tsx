import type { GraphRow } from '../domain/index.js';

const laneWidth = 12;
const maximumColumns = 8;

export function GraphSvg({ row }: { row: GraphRow }) {
  const columns = Math.min(Math.max(row.input.length, row.output.length, row.column + 1), maximumColumns);
  const outputIndex = (id: string) => row.output.findIndex((lane) => lane.id === id);
  const visible = (index: number) => index >= 0 && index < maximumColumns;
  return <span className="git-graph-topology" data-git-graph-topology="true"><svg width={columns * laneWidth} height="24" aria-hidden="true" viewBox={`0 0 ${columns * laneWidth} 24`}>
    {row.input.map((lane, index) => {
      const target = outputIndex(lane.id);
      return visible(index) && visible(target) ? <line key={`in:${lane.id}`} x1={index * laneWidth + 6} y1="0" x2={target * laneWidth + 6} y2="24" stroke={lane.color} /> : null;
    })}
    {row.output.filter((lane) => !row.input.some((item) => item.id === lane.id)).map((lane) => {
      const target = outputIndex(lane.id);
      return visible(row.column) && visible(target) ? <line key={`new:${lane.id}`} x1={row.column * laneWidth + 6} y1="12" x2={target * laneWidth + 6} y2="24" stroke={lane.color} /> : null;
    })}
    {visible(row.column) && <circle cx={row.column * laneWidth + 6} cy="12" r="5" fill={row.color} />}
  </svg></span>;
}
