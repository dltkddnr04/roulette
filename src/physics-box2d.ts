import Box2DFactory from 'box2d-wasm';
import { MARBLE_PHYSICS_RADIUS } from './data/constants';
import type { StageDef } from './data/maps';
import type { IPhysics } from './IPhysics';
import type { MapEntity, MapEntityRenderState } from './types/MapEntity.type';
import type { Transform } from './utils/interpolation';
import type { RandomSource } from './utils/random';

export class Box2dPhysics implements IPhysics {
  private readonly randomSource: RandomSource;
  private Box2D!: typeof Box2D & EmscriptenModule;
  private gravity!: Box2D.b2Vec2;
  private world!: Box2D.b2World;

  private marbleMap: { [id: number]: Box2D.b2Body } = {};
  private entities: {
    body: Box2D.b2Body;
    renderState: MapEntityRenderState;
    destroyOnContact: boolean;
  }[] = [];

  private deleteCandidates: Box2D.b2Body[] = [];

  constructor(randomSource: RandomSource) {
    this.randomSource = randomSource;
  }

  async init(): Promise<void> {
    this.Box2D = await Box2DFactory();
    this.gravity = new this.Box2D.b2Vec2(0, 10);
    this.world = new this.Box2D.b2World(this.gravity);
  }

  clearMarbles(): void {
    Object.values(this.marbleMap).forEach((body) => {
      this.world.DestroyBody(body);
    });
    this.marbleMap = {};
  }

  loadStage(stage: StageDef): void {
    this.clearEntities();
    this.createEntities(stage.entities);
  }

  private createEntities(entities?: MapEntity[]) {
    if (!entities) return;

    const bodyTypes = {
      static: this.Box2D.b2_staticBody,
      kinematic: this.Box2D.b2_kinematicBody,
    } as const;

    entities.forEach((entity) => {
      const bodyDef = new this.Box2D.b2BodyDef();
      bodyDef.set_type(bodyTypes[entity.type]);
      const body = this.world.CreateBody(bodyDef);

      const fixtureDef = new this.Box2D.b2FixtureDef();
      fixtureDef.set_restitution(entity.props.restitution);

      let shape;
      switch (entity.shape.type) {
        case 'box':
          shape = new this.Box2D.b2PolygonShape();
          shape.SetAsBox(entity.shape.halfWidth, entity.shape.halfHeight, 0, entity.shape.rotation);
          fixtureDef.set_shape(shape);
          body.CreateFixture(fixtureDef);
          break;
        case 'polyline':
          for (let i = 0; i < entity.shape.points.length - 1; i++) {
            const p1 = entity.shape.points[i];
            const p2 = entity.shape.points[i + 1];
            const v1 = new this.Box2D.b2Vec2(p1[0], p1[1]);
            const v2 = new this.Box2D.b2Vec2(p2[0], p2[1]);
            const edge = new this.Box2D.b2EdgeShape();
            edge.SetTwoSided(v1, v2);
            fixtureDef.set_shape(edge);
            body.CreateFixture(fixtureDef);
          }
          break;
        case 'circle':
          shape = new this.Box2D.b2CircleShape();
          shape.set_m_radius(entity.shape.radius);
          fixtureDef.set_shape(shape);
          body.CreateFixture(fixtureDef);
          break;
      }

      if (entity.props.angularVelocity !== undefined) {
        body.SetAngularVelocity(entity.props.angularVelocity);
      }
      body.SetTransform(new this.Box2D.b2Vec2(entity.position.x, entity.position.y), 0);
      this.entities.push({
        body,
        renderState: {
          id: this.entities.length,
          x: entity.position.x,
          y: entity.position.y,
          angle: 0,
          shape: entity.shape,
        },
        destroyOnContact: entity.props.destroyOnContact ?? false,
      });
    });
  }

  clearEntities(): void {
    this.deleteCandidates.forEach((body) => {
      this.world.DestroyBody(body);
    });
    this.deleteCandidates = [];
    this.entities.forEach((entity) => {
      this.world.DestroyBody(entity.body);
    });
    this.entities = [];
  }

  createMarble(id: number, x: number, y: number): void {
    if (this.marbleMap[id]) {
      throw new Error(`Marble with id ${id} already exists`);
    }

    const circleShape = new this.Box2D.b2CircleShape();
    circleShape.set_m_radius(MARBLE_PHYSICS_RADIUS);

    const bodyDef = new this.Box2D.b2BodyDef();
    bodyDef.set_type(this.Box2D.b2_dynamicBody);
    bodyDef.set_position(new this.Box2D.b2Vec2(x, y));

    const body = this.world.CreateBody(bodyDef);
    body.CreateFixture(circleShape, 1 + this.randomSource.next());
    body.SetAwake(false);
    body.SetEnabled(false);
    this.marbleMap[id] = body;
  }

  shakeMarble(id: number): void {
    const body = this.marbleMap[id];
    if (body) {
      body.ApplyLinearImpulseToCenter(
        new this.Box2D.b2Vec2(this.randomSource.next() * 10 - 5, this.randomSource.next() * 10 - 5),
        true
      );
    }
  }

  removeMarble(id: number): void {
    const marble = this.marbleMap[id];
    if (marble) {
      this.world.DestroyBody(marble);
      delete this.marbleMap[id];
    }
  }

  getMarblePosition(id: number): Transform | undefined {
    const marble = this.marbleMap[id];
    if (!marble) return undefined;

    const pos = marble.GetPosition();
    return { x: pos.x, y: pos.y, angle: marble.GetAngle() };
  }

  getEntityRenderStates(): MapEntityRenderState[] {
    return this.entities.map(({ body, renderState }) => {
      return {
        ...renderState,
        angle: body.GetAngle(),
      };
    });
  }

  impact(id: number): void {
    const src = this.marbleMap[id];
    if (!src) return;

    Object.values(this.marbleMap).forEach((body) => {
      if (body === src) return;

      const distVector = new this.Box2D.b2Vec2(body.GetPosition().x, body.GetPosition().y);
      distVector.op_sub(src.GetPosition());
      const distSq = distVector.LengthSquared();

      if (distSq < 100) {
        const distance = Math.sqrt(distSq);
        distVector.Normalize();
        const power = 1 - distance / 10;
        distVector.op_mul(power * power * 5);
        body.ApplyLinearImpulseToCenter(distVector, true);
      }
    });
  }

  start(): void {
    for (const key in this.marbleMap) {
      const marble = this.marbleMap[key];
      marble.SetAwake(true);
      marble.SetEnabled(true);
    }
  }

  step(deltaSeconds: number): void {
    this.deleteCandidates.forEach((body) => {
      this.world.DestroyBody(body);
    });
    this.deleteCandidates = [];

    this.world.Step(deltaSeconds, 6, 2);

    for (let i = this.entities.length - 1; i >= 0; i--) {
      const entity = this.entities[i];
      if (entity.destroyOnContact) {
        const edge = entity.body.GetContactList();
        if (edge.contact?.IsTouching()) {
          this.deleteCandidates.push(entity.body);
          this.entities.splice(i, 1);
        }
      }
    }
  }
}
