import type { Transform } from '../utils/interpolation';

export type MarbleRenderState = Readonly<{
  id: number;
  name: string;
  hue: number;
  size: number;
  impact: number;
  coolTime: number;
  maxCoolTime: number;
  position: Readonly<Transform>;
}>;

export type MarblePresentationState = Readonly<Pick<MarbleRenderState, 'id' | 'name' | 'hue'>>;
