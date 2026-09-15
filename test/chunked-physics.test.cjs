const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const typescript = require('typescript');

const moduleCache = new Map();

function loadTypeScriptModule(filePath) {
  const resolvedPath = path.resolve(filePath);
  if (moduleCache.has(resolvedPath)) return moduleCache.get(resolvedPath).exports;

  const module = { exports: {} };
  moduleCache.set(resolvedPath, module);
  const source = fs.readFileSync(resolvedPath, 'utf8');
  const output = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: resolvedPath,
  }).outputText;
  const localRequire = (request) => {
    if (!request.startsWith('.')) return require(request);
    const dependency = path.resolve(path.dirname(resolvedPath), request);
    return loadTypeScriptModule(dependency.endsWith('.ts') ? dependency : `${dependency}.ts`);
  };

  new Function('exports', 'module', 'require', output)(module.exports, module, localRequire);
  return module.exports;
}

const { RaceSimulation } = loadTypeScriptModule('src/raceSimulation.ts');
const { RoundSession } = loadTypeScriptModule('src/roundSession.ts');
const { Box2dPhysics } = loadTypeScriptModule('src/physics-box2d.ts');
const { createSeededRandom } = loadTypeScriptModule('src/utils/random.ts');

function waitForTask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createCleanupPhysics() {
  const positions = new Map();
  let cleanupIds = null;
  let cleanupIndex = 0;
  let cleanupBatchCalls = 0;
  let maxCleanupBatch = 0;
  let destroyedBodies = 0;
  let bulkClearCalls = 0;
  let stepCalls = 0;
  let disposeCalls = 0;
  let movedOneMarble = false;

  return {
    init: async () => {},
    loadStage() {},
    clearEntities() {},
    resetWorld() {},
    clearMarbles() {
      bulkClearCalls++;
      destroyedBodies += positions.size;
      positions.clear();
      cleanupIds = null;
      cleanupIndex = 0;
    },
    clearMarblesBatch(limit) {
      cleanupBatchCalls++;
      const batchSize = Math.max(1, Math.floor(limit));
      maxCleanupBatch = Math.max(maxCleanupBatch, batchSize);
      if (!cleanupIds) {
        cleanupIds = [...positions.keys()];
        cleanupIndex = 0;
      }
      let removed = 0;
      while (cleanupIndex < cleanupIds.length && removed < batchSize) {
        const id = cleanupIds[cleanupIndex++];
        if (!positions.has(id)) continue;
        positions.delete(id);
        destroyedBodies++;
        removed++;
      }
      if (cleanupIndex >= cleanupIds.length) {
        cleanupIds = null;
        cleanupIndex = 0;
        return true;
      }
      return false;
    },
    createMarble(id, x, y) {
      positions.set(id, { x, y, angle: 0 });
    },
    getMarblePosition(id) {
      return positions.get(id);
    },
    shakeMarble() {},
    removeMarble(id) {
      if (positions.delete(id)) destroyedBodies++;
    },
    impact() {},
    start() {},
    step() {
      stepCalls++;
      if (movedOneMarble) return;
      const first = positions.values().next().value;
      if (first) first.y = 100;
      movedOneMarble = true;
    },
    getEntityRenderStates() {
      return [];
    },
    dispose() {
      disposeCalls++;
      positions.clear();
      cleanupIds = null;
      cleanupIndex = 0;
    },
    positions,
    counters() {
      return {
        cleanupBatchCalls,
        maxCleanupBatch,
        destroyedBodies,
        bulkClearCalls,
        stepCalls,
        disposeCalls,
        marbleCount: positions.size,
      };
    },
  };
}

function runSimulation(simulation, targetRank) {
  const finished = [];
  simulation.start();
  for (let frame = 0; finished.length <= targetRank; frame++) {
    if (frame > 1000) throw new Error('chunked stage equivalence race did not settle');
    simulation.advance(80, 1, 1, {
      onImpact() {},
      onFinish(marble) {
        finished.push(marble.id);
      },
      afterStep() {
        return 1;
      },
      onStepComplete() {},
    });
  }
  return finished.slice(0, targetRank + 1);
}

function chunkedEquivalenceStage() {
  return {
    title: 'chunked stage equivalence',
    finish: { y: 12 },
    camera: { zoomTriggerY: 10 },
    spawn: {
      origin: { x: 10.25, y: 1 },
      maxColumns: 10,
      columnSpacing: 0.6,
      rowSpacing: 1,
      maxUnshiftedRows: 5,
    },
    entities: [
      {
        type: 'static',
        position: { x: 100, y: 0 },
        shape: {
          type: 'polyline',
          points: [
            [0, 0],
            [1, 0],
            [2, 0],
            [3, 0],
            [4, 0],
          ],
        },
        props: { restitution: 0 },
      },
      {
        type: 'kinematic',
        position: { x: 100, y: 0 },
        shape: { type: 'box', halfWidth: 0.5, halfHeight: 0.1, rotation: 0 },
        props: { angularVelocity: 2, restitution: 0 },
      },
      {
        type: 'static',
        position: { x: 100, y: 0 },
        shape: { type: 'circle', radius: 0.2 },
        props: { restitution: 0, destroyOnContact: true },
      },
    ],
  };
}

async function withNodeBox2d(callback) {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = undefined;
  console.log = () => {};
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
}

test('deferred finish cleanup destroys marble bodies in bounded batches', async () => {
  const physics = createCleanupPhysics();
  const session = new RoundSession(new RaceSimulation(physics, 'chunked-cleanup-seed'));
  const stage = {
    title: 'cleanup stage',
    finish: { y: 20 },
    camera: { zoomTriggerY: 10 },
    spawn: {
      origin: { x: 10.25, y: 1 },
      maxColumns: 10,
      columnSpacing: 0.6,
      rowSpacing: 1,
      maxUnshiftedRows: 5,
    },
    entities: [],
  };
  await session.init();
  session.loadStage(stage);
  session.markReady();
  session.setParticipants(['A*1000']);
  const generation = session.prepareStart();
  assert.notEqual(generation, null);
  assert.equal(session.activate(generation), true);

  session.advance(80, 1, 1, {
    onImpact() {},
    onFinish() {},
    afterStep() {
      return 1;
    },
    onStepComplete() {},
  });
  const finish = session.checkFinish();
  assert.ok(finish);
  const beforeCleanup = physics.counters();
  assert.equal(beforeCleanup.cleanupBatchCalls, 0);
  assert.equal(beforeCleanup.maxCleanupBatch, 0);
  assert.equal(session.getResult().length, 1);
  session.setParticipants(['A*1000']);

  await waitForTask();
  const firstBatch = physics.counters();
  assert.equal(firstBatch.cleanupBatchCalls, 1);
  assert.equal(firstBatch.maxCleanupBatch, 64);
  assert.ok(firstBatch.marbleCount > 0);
  assert.equal(firstBatch.destroyedBodies, 65);

  for (let attempt = 0; physics.counters().marbleCount > 0 && attempt < 40; attempt++) {
    await waitForTask();
  }
  const complete = physics.counters();
  assert.equal(complete.marbleCount, 0);
  assert.equal(complete.destroyedBodies, 1000);
  assert.equal(complete.cleanupBatchCalls, 16);
  assert.equal(complete.bulkClearCalls, 1);

  const stepsAfterFinish = complete.stepCalls;
  session.advance(80, 1, 1, {
    onImpact() {},
    onFinish() {},
    afterStep() {
      return 1;
    },
    onStepComplete() {},
  });
  assert.ok(physics.counters().stepCalls > stepsAfterFinish);
});

test('cancelled deferred cleanup cannot touch a newly prepared current simulation', async () => {
  const physics = createCleanupPhysics();
  const session = new RoundSession(new RaceSimulation(physics, 'cleanup-ownership-seed'));
  const stage = {
    title: 'cleanup ownership stage',
    finish: { y: 20 },
    camera: { zoomTriggerY: 10 },
    spawn: {
      origin: { x: 10.25, y: 1 },
      maxColumns: 10,
      columnSpacing: 0.6,
      rowSpacing: 1,
      maxUnshiftedRows: 5,
    },
    entities: [],
  };
  await session.init();
  session.loadStage(stage);
  session.markReady();
  session.setParticipants(['A*1000']);
  const generation = session.prepareStart();
  assert.equal(session.activate(generation), true);
  session.advance(80, 1, 1, {
    onImpact() {},
    onFinish() {},
    afterStep() {
      return 1;
    },
    onStepComplete() {},
  });
  assert.ok(session.checkFinish());

  const beforeStart = physics.counters();
  assert.equal(beforeStart.cleanupBatchCalls, 0);
  const nextGeneration = session.prepareStart();
  assert.notEqual(nextGeneration, null);
  assert.equal(session.roundState, 'running');
  const afterStart = physics.counters();
  assert.equal(afterStart.marbleCount, 1000);
  assert.equal(afterStart.cleanupBatchCalls, 0);
  await waitForTask();
  assert.equal(physics.counters().cleanupBatchCalls, 0);
  assert.equal(physics.counters().marbleCount, 1000);
});

test('chunked stage preparation is cancellable between fixture batches', async () => {
  let batchCalls = 0;
  let disposeCalls = 0;
  const physics = {
    init: async () => {},
    clearEntities() {},
    clearMarbles() {},
    resetWorld() {},
    loadStage() {},
    beginStageLoad() {},
    loadStageEntityBatch() {
      batchCalls++;
      return false;
    },
    createMarble() {},
    shakeMarble() {},
    removeMarble() {},
    getMarblePosition() {
      return { x: 0, y: 0, angle: 0 };
    },
    getEntityRenderStates() {
      return [];
    },
    impact() {},
    start() {},
    step() {},
    dispose() {
      disposeCalls++;
    },
  };
  const simulation = new RaceSimulation(physics, 'cancel-stage-seed');
  const stage = chunkedEquivalenceStage();
  const complete = await simulation.loadStageChunked(stage, 1, () => batchCalls < 1);
  assert.equal(complete, false);
  assert.equal(batchCalls, 1);
  simulation.dispose();
  assert.equal(disposeCalls, 1);
});

test('Box2D marble batch cleanup destroys each owned body once', async () => {
  await withNodeBox2d(async () => {
    const physics = new Box2dPhysics(createSeededRandom('batch-cleanup-box2d'));
    const stage = chunkedEquivalenceStage();
    try {
      await physics.init();
      physics.loadStage(stage);
      for (let id = 0; id < 130; id++) physics.createMarble(id, 10 + id * 0.01, 1);

      assert.equal(physics.clearMarblesBatch(64), false);
      assert.equal(physics.getMarblePosition(0), undefined);
      assert.notEqual(physics.getMarblePosition(64), undefined);
      assert.equal(physics.clearMarblesBatch(64), false);
      assert.equal(physics.clearMarblesBatch(64), true);
      for (let id = 0; id < 130; id++) assert.equal(physics.getMarblePosition(id), undefined);
    } finally {
      physics.dispose();
    }
  });
});

test('chunked Box2D stage preparation matches one-shot stage and race results', async () => {
  await withNodeBox2d(async () => {
    const stage = chunkedEquivalenceStage();
    const participants = [
      { name: 'A', weight: 0.25, count: 2 },
      { name: 'B', weight: 1, count: 2 },
    ];
    const seed = 'chunked-stage-equivalence-seed';
    const spawnPositions = [
      { x: 10.25, y: 1 },
      { x: 10.85, y: 1 },
      { x: 11.45, y: 1 },
      { x: 12.05, y: 1 },
    ];
    const oneShot = new RaceSimulation(undefined, seed);
    const chunked = new RaceSimulation(undefined, seed);
    try {
      await oneShot.init();
      await chunked.init();
      oneShot.loadStage(stage);
      assert.equal(await chunked.loadStageChunked(stage, 1), true);
      assert.deepEqual(chunked.getEntityRenderStates(0), oneShot.getEntityRenderStates(0));

      oneShot.replaceMarbles(participants, 4, spawnPositions, seed);
      chunked.replaceMarbles(participants, 4, spawnPositions, seed);
      assert.deepEqual(chunked.getRenderStates(0), oneShot.getRenderStates(0));
      assert.deepEqual(runSimulation(chunked, 3), runSimulation(oneShot, 3));
    } finally {
      oneShot.dispose();
      chunked.dispose();
    }
  });
});
