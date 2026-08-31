import type { MarbleSpawnDefinition } from '../data/maps';
import type { VectorLike } from '../types/VectorLike';

export type MarbleSpawnLayout = {
  positions: VectorLike[];
  center: VectorLike;
  width: number;
  height: number;
};

type SpawnMetrics = {
  columns: number;
  rows: number;
  shift: number;
};

function getSpawnMetrics(totalCount: number, spawn: MarbleSpawnDefinition): SpawnMetrics {
  const columns = Math.min(totalCount, spawn.maxColumns);
  const rows = Math.ceil(totalCount / spawn.maxColumns);
  const shift = -Math.max(0, Math.ceil(rows - spawn.maxUnshiftedRows));
  return { columns, rows, shift };
}

export function getMarbleSpawnPosition(order: number, totalCount: number, spawn: MarbleSpawnDefinition): VectorLike {
  const { rows, shift } = getSpawnMetrics(totalCount, spawn);
  const row = Math.floor(order / spawn.maxColumns);

  return {
    x: spawn.origin.x + (order % spawn.maxColumns) * spawn.columnSpacing,
    y: spawn.origin.y + (rows - 1 - row) * spawn.rowSpacing + shift,
  };
}

export function getMarbleSpawnLayout(totalCount: number, spawn: MarbleSpawnDefinition): MarbleSpawnLayout {
  const { columns, rows, shift } = getSpawnMetrics(totalCount, spawn);

  return {
    positions: Array.from({ length: totalCount }, (_, order) => getMarbleSpawnPosition(order, totalCount, spawn)),
    center: {
      x: spawn.origin.x + ((columns - 1) * spawn.columnSpacing) / 2,
      y: spawn.origin.y + ((rows - 1) * spawn.rowSpacing) / 2 + shift,
    },
    width: Math.max((columns - 1) * spawn.columnSpacing, 1),
    height: Math.max((rows - 1) * spawn.rowSpacing, 1),
  };
}
