import Box2DFactory from 'box2d-wasm';
import { MARBLE_PHYSICS_RADIUS } from './data/constants';
import type { StageDef } from './data/maps';
import type { IPhysics } from './IPhysics';
import type { MapEntity, MapEntityRenderState } from './types/MapEntity.type';
import type { Transform } from './utils/interpolation';
import type { RandomSource } from './utils/random';

type Box2DModule = typeof Box2D & EmscriptenModule;

type PendingStageEntity = {
  entity: MapEntity;
  body: Box2D.b2Body;
  fixtureDef: Box2D.b2FixtureDef;
  nextPolylineSegment: number;
  fixtureCreated: boolean;
};

type StageLoadState = {
  entities: readonly MapEntity[];
  entityIndex: number;
  pendingEntity: PendingStageEntity | null;
};

let box2dModulePromise: Promise<Box2DModule> | null = null;

function loadBox2D(): Promise<Box2DModule> {
  if (!box2dModulePromise) {
    box2dModulePromise = Box2DFactory().catch((error) => {
      box2dModulePromise = null;
      throw error;
    });
  }
  return box2dModulePromise;
}

export class Box2dPhysics implements IPhysics {
  private readonly randomSource: RandomSource;
  private Box2D!: Box2DModule;
  private world!: Box2D.b2World;
  private worldDestroyed = false;

  private marbleMap: { [id: number]: Box2D.b2Body } = {};
  private marbleCleanupIds: number[] | null = null;
  private marbleCleanupIndex = 0;
  private entities: {
    body: Box2D.b2Body;
    renderState: MapEntityRenderState;
    destroyOnContact: boolean;
  }[] = [];

  private stageLoadState: StageLoadState | null = null;

  private deleteCandidates: Box2D.b2Body[] = [];

  constructor(randomSource: RandomSource) {
    this.randomSource = randomSource;
  }

  async init(): Promise<void> {
    this.Box2D = await loadBox2D();
    this.resetWorld();
  }

  clearMarbles(): void {
    this.beginClearMarbles();
    while (!this.clearMarblesBatch(Number.POSITIVE_INFINITY)) {
      // The unbounded compatibility API intentionally keeps its historical
      // synchronous behavior. Deferred callers use clearMarblesBatch().
    }
  }

  clearMarblesBatch(limit: number): boolean {
    this.beginClearMarbles();
    const batchSize = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : Number.MAX_SAFE_INTEGER;
    const ids = this.marbleCleanupIds!;
    let removed = 0;
    while (this.marbleCleanupIndex < ids.length && removed < batchSize) {
      const id = ids[this.marbleCleanupIndex++];
      const body = this.marbleMap[id];
      if (!body) continue;
      this.world.DestroyBody(body);
      delete this.marbleMap[id];
      removed++;
    }

    if (this.marbleCleanupIndex >= ids.length) {
      this.marbleCleanupIds = null;
      this.marbleCleanupIndex = 0;
      this.marbleMap = {};
      return true;
    }
    return false;
  }

  private beginClearMarbles(): void {
    if (this.marbleCleanupIds) return;
    this.marbleCleanupIds = Object.keys(this.marbleMap).map(Number);
    this.marbleCleanupIndex = 0;
  }

  resetWorld(): void {
    this.stageLoadState = null;
    this.marbleCleanupIds = null;
    this.marbleCleanupIndex = 0;
    this.marbleMap = {};
    this.entities = [];
    this.deleteCandidates = [];

    if (this.world && !this.worldDestroyed) {
      this.Box2D.destroy(this.world);
    }

    const gravity = new this.Box2D.b2Vec2(0, 10);
    this.world = new this.Box2D.b2World(gravity);
    this.Box2D.destroy(gravity);
    this.worldDestroyed = false;
  }

  dispose(): void {
    this.stageLoadState = null;
    this.marbleCleanupIds = null;
    this.marbleCleanupIndex = 0;
    this.marbleMap = {};
    this.entities = [];
    this.deleteCandidates = [];
    if (this.world && !this.worldDestroyed) {
      this.Box2D.destroy(this.world);
      this.worldDestroyed = true;
    }
  }

  loadStage(stage: StageDef): void {
    this.beginStageLoad(stage);
    while (!this.loadStageEntityBatch(Number.POSITIVE_INFINITY)) {
      // The unbounded compatibility API intentionally keeps its historical
      // synchronous behavior. Standby preparation uses bounded batches.
    }
  }

  beginStageLoad(stage: StageDef): void {
    this.resetWorld();
    this.stageLoadState = {
      entities: stage.entities ?? [],
      entityIndex: 0,
      pendingEntity: null,
    };
  }

  loadStageEntityBatch(limit: number): boolean {
    const state = this.stageLoadState;
    if (!state) return true;

    const batchSize = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : Number.MAX_SAFE_INTEGER;
    let work = 0;
    while (state.entityIndex < state.entities.length && work < batchSize) {
      if (!state.pendingEntity) state.pendingEntity = this.beginStageEntity(state.entities[state.entityIndex]);
      const pending = state.pendingEntity;

      if (pending.entity.shape.type === 'polyline') {
        const lastSegment = pending.entity.shape.points.length - 1;
        if (pending.nextPolylineSegment < lastSegment) {
          this.createPolylineFixture(pending);
          pending.nextPolylineSegment++;
          work++;
        }
        if (pending.nextPolylineSegment >= lastSegment) this.finishStageEntity(state, pending);
        continue;
      }

      if (!pending.fixtureCreated) {
        this.createSingleFixture(pending);
        pending.fixtureCreated = true;
        work++;
      }
      this.finishStageEntity(state, pending);
    }

    if (state.entityIndex >= state.entities.length && !state.pendingEntity) {
      this.stageLoadState = null;
      return true;
    }
    return false;
  }

  private beginStageEntity(entity: MapEntity): PendingStageEntity {
    const bodyTypes = {
      static: this.Box2D.b2_staticBody,
      kinematic: this.Box2D.b2_kinematicBody,
    } as const;

    const bodyDef = new this.Box2D.b2BodyDef();
    bodyDef.set_type(bodyTypes[entity.type]);
    const body = this.world.CreateBody(bodyDef);
    const fixtureDef = new this.Box2D.b2FixtureDef();
    fixtureDef.set_restitution(entity.props.restitution);
    return {
      entity,
      body,
      fixtureDef,
      nextPolylineSegment: 0,
      fixtureCreated: false,
    };
  }

  private createSingleFixture(pending: PendingStageEntity): void {
    const { entity, body, fixtureDef } = pending;
    switch (entity.shape.type) {
      case 'box': {
        const shape = new this.Box2D.b2PolygonShape();
        shape.SetAsBox(entity.shape.halfWidth, entity.shape.halfHeight, 0, entity.shape.rotation);
        fixtureDef.set_shape(shape);
        body.CreateFixture(fixtureDef);
        break;
      }
      case 'circle': {
        const shape = new this.Box2D.b2CircleShape();
        shape.set_m_radius(entity.shape.radius);
        fixtureDef.set_shape(shape);
        body.CreateFixture(fixtureDef);
        break;
      }
    }
  }

  private createPolylineFixture(pending: PendingStageEntity): void {
    if (pending.entity.shape.type !== 'polyline') return;
    const { points } = pending.entity.shape;
    const index = pending.nextPolylineSegment;
    const p1 = points[index];
    const p2 = points[index + 1];
    const v1 = new this.Box2D.b2Vec2(p1[0], p1[1]);
    const v2 = new this.Box2D.b2Vec2(p2[0], p2[1]);
    const edge = new this.Box2D.b2EdgeShape();
    edge.SetTwoSided(v1, v2);
    pending.fixtureDef.set_shape(edge);
    pending.body.CreateFixture(pending.fixtureDef);
  }

  private finishStageEntity(state: StageLoadState, pending: PendingStageEntity): void {
    const { entity, body } = pending;
    if (entity.props.angularVelocity !== undefined) body.SetAngularVelocity(entity.props.angularVelocity);
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
    state.entityIndex++;
    state.pendingEntity = null;
  }

  clearEntities(): void {
    const pending = this.stageLoadState?.pendingEntity;
    if (pending) this.world.DestroyBody(pending.body);
    this.stageLoadState = null;
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
