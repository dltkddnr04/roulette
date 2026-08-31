import type { VectorLike } from './VectorLike';

export type EntityShapeTypes = 'box' | 'circle' | 'polyline';

export interface EntityShapeBase {
  type: EntityShapeTypes;
  color?: string;
  bloomColor?: string;
}

export interface EntityBoxShape extends EntityShapeBase {
  type: 'box';
  halfWidth: number;
  halfHeight: number;
  rotation: number;
}

export interface EntityCircleShape extends EntityShapeBase {
  type: 'circle';
  radius: number;
}

export interface EntityPolylineShape extends EntityShapeBase {
  type: 'polyline';
  points: [number, number][];
}

export type EntityShape = EntityBoxShape | EntityCircleShape | EntityPolylineShape;

type EntityPhysicalPropsBase = {
  restitution: number;
  destroyOnContact?: boolean;
};

export type StaticPhysicalProps = EntityPhysicalPropsBase & {
  angularVelocity?: never;
};

export type KinematicPhysicalProps = EntityPhysicalPropsBase & {
  angularVelocity?: number;
};

export type EntityPhysicalProps = StaticPhysicalProps | KinematicPhysicalProps;

export type MapEntity =
  | {
      position: VectorLike;
      type: 'static';
      shape: EntityShape;
      props: StaticPhysicalProps;
    }
  | {
      position: VectorLike;
      type: 'kinematic';
      shape: EntityShape;
      props: KinematicPhysicalProps;
    };

export interface MapEntityRenderState {
  id: number;
  x: number;
  y: number;
  angle: number;
  shape: EntityShape;
}
