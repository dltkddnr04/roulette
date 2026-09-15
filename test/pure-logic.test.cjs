const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const typescript = require('typescript');

const moduleCache = new Map();

function loadTypeScriptModule(filePath, options = {}) {
  const resolvedPath = path.resolve(filePath);
  if (moduleCache.has(resolvedPath)) return moduleCache.get(resolvedPath).exports;

  const module = { exports: {} };
  moduleCache.set(resolvedPath, module);
  const source = fs.readFileSync(resolvedPath, 'utf8');
  let output = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: resolvedPath,
  }).outputText;
  if (options.replaceImportMeta) {
    output = output.split('import.meta.url').join(JSON.stringify(`file://${resolvedPath}`));
  }
  const localRequire = (request) => {
    if (!request.startsWith('.')) return require(request);
    const dependency = path.resolve(path.dirname(resolvedPath), request);
    return loadTypeScriptModule(dependency.endsWith('.ts') ? dependency : `${dependency}.ts`);
  };

  new Function('exports', 'module', 'require', output)(module.exports, module, localRequire);
  return module.exports;
}

const { parseName, shuffle } = loadTypeScriptModule('src/utils/utils.ts');
const { normalizeParticipantNames } = loadTypeScriptModule('src/utils/participants.ts');
const { getMarbleSpawnLayout } = loadTypeScriptModule('src/utils/marbleSpawn.ts');
const { Marble } = loadTypeScriptModule('src/marble.ts');
const { createMarblePreviewStates, getStepBudget, preservePhysicsDebt, RaceSimulation } =
  loadTypeScriptModule('src/raceSimulation.ts');
const { HeadlessSimulationCancelledError, simulateHeadlessRace } = loadTypeScriptModule('src/headlessSimulation.ts');
const { RoundSession } = loadTypeScriptModule('src/roundSession.ts');
const { validateReplayDescriptor } = loadTypeScriptModule('src/replay.ts');
const { createSeededRandom } = loadTypeScriptModule('src/utils/random.ts');
const { SimulationClient } = loadTypeScriptModule('src/simulationClient.ts');
const {
  canUseStrictBalanceEntryFastPath,
  canUseStrictBalanceFastPath,
  createFairnessCandidateSeed,
  createFairnessExport,
  evaluateStrictBalance,
  evaluateStrictBalanceEntries,
  LEGACY_FAIRNESS_DATA_VERSION,
  applyFairnessEvent,
  projectFairnessEvents,
  searchBudget,
  validateFairnessExport,
} = loadTypeScriptModule('src/fairness.ts');
const { FairnessCoordinator, mapMarbleIdsToParticipants, parseFairnessEntryName, runHeadlessRace } =
  loadTypeScriptModule('src/fairnessCoordinator.ts');
const { InMemoryFairnessStore } = loadTypeScriptModule('src/fairnessStore.ts');
const { FairnessWorkerPool, WorkerPoolUnavailableError } = loadTypeScriptModule('src/fairnessWorkerPool.ts', {
  replaceImportMeta: true,
});

test('parseName preserves supported participant syntax and rejects malformed modifiers', () => {
  assert.deepEqual(parseName('Alice'), { name: 'Alice', weight: 1, count: 1 });
  assert.deepEqual(parseName('Alice/2'), { name: 'Alice', weight: 2, count: 1 });
  assert.deepEqual(parseName('Alice*3'), { name: 'Alice', weight: 1, count: 3 });
  assert.deepEqual(parseName('Alice/2*3'), { name: 'Alice', weight: 2, count: 3 });
  assert.deepEqual(parseName('Alice*3/2'), { name: 'Alice', weight: 2, count: 3 });
  assert.equal(parseName('Alice/1.5'), null);
  assert.equal(parseName('Alice*2abc'), null);
  assert.equal(parseName('Alice*2*3'), null);
});

test('replay descriptor validates simulation inputs and returns defensive copies', () => {
  const input = {
    version: 1,
    seed: 'demo',
    mapIndex: 0,
    participants: ['Alice/2*3', 'Bob*2'],
    winnerRange: { start: 0, end: 1 },
    skillsEnabled: true,
  };
  const descriptor = validateReplayDescriptor(input, 4);

  assert.deepEqual(descriptor, input);
  assert.notEqual(descriptor.participants, input.participants);
  assert.notEqual(descriptor.winnerRange, input.winnerRange);
  assert.deepEqual(validateReplayDescriptor(JSON.parse(JSON.stringify(descriptor)), 4), descriptor);
  assert.throws(() => validateReplayDescriptor({ ...input, version: 2 }, 4), /unsupported version/);
  assert.throws(() => validateReplayDescriptor({ ...input, participants: ['Alice/1.5'] }, 4), /participants/);
  assert.throws(() => validateReplayDescriptor({ ...input, seed: Number.NaN }, 4), /seed/);
  assert.throws(() => validateReplayDescriptor({ ...input, winnerRange: { start: 2, end: 1 } }, 4), /winnerRange/);
});

test('participant normalization safely aggregates special names without changing order', () => {
  assert.deepEqual(normalizeParticipantNames(['__proto__', '__proto__*2', 'A/2', 'A/2*2', 'A*3/2']), [
    '__proto__*3',
    'A/2*6',
  ]);
});

test('spawn layout produces one position per participant', () => {
  const spawn = {
    origin: { x: 10.25, y: 1 },
    maxColumns: 10,
    columnSpacing: 0.6,
    rowSpacing: 1,
    maxUnshiftedRows: 5,
  };
  for (const count of [1, 10, 11, 50, 51, 1000]) {
    const layout = getMarbleSpawnLayout(count, spawn);
    assert.equal(layout.positions.length, count);
    assert.ok(Number.isFinite(layout.center.x));
    assert.ok(Number.isFinite(layout.center.y));
  }
});

test('marble exposes a presentation snapshot without canvas responsibilities', () => {
  const positions = new Map();
  const physics = {
    createMarble(id, x, y) {
      positions.set(id, { x, y, angle: 0 });
    },
    getMarblePosition(id) {
      return positions.get(id);
    },
    shakeMarble() {},
  };

  const marble = new Marble(physics, 2, 10, { x: 10, y: 3 }, createSeededRandom(0), 'Alice', 0.5);
  const state = marble.getRenderState({ x: 11, y: 4, angle: Math.PI / 2 });

  assert.deepEqual(state, {
    id: 2,
    name: 'Alice',
    hue: 72,
    size: 0.5,
    impact: 0,
    coolTime: marble.getRenderState({ x: 0, y: 0, angle: 0 }).coolTime,
    maxCoolTime: 3000,
    position: { x: 11, y: 4, angle: Math.PI / 2 },
  });
  assert.equal(typeof marble.render, 'undefined');
});

test('seeded random uses the stable mulberry32-v1 sequence', () => {
  const expected = [
    0.26642920868471265, 0.0003297457005828619, 0.22327202744781971, 0.1462021479383111, 0.46732782293111086,
    0.5450490827206522, 0.6152513844426721, 0.6489853798411787, 0.45600721263326705, 0.581218967679888,
  ];
  const first = createSeededRandom(0);
  assert.deepEqual(
    expected.map(() => first.next()),
    expected
  );

  const numeric = createSeededRandom(123456);
  const numericAgain = createSeededRandom(123456);
  assert.deepEqual(
    Array.from({ length: 10 }, () => numeric.next()),
    Array.from({ length: 10 }, () => numericAgain.next())
  );

  const string = createSeededRandom('roulette-seed');
  const stringAgain = createSeededRandom('roulette-seed');
  assert.deepEqual(string.next(), stringAgain.next());
  assert.notEqual(string.next(), createSeededRandom('other-seed').next());

  const zero = createSeededRandom(0);
  const firstZero = zero.next();
  assert.ok(firstZero > 0);
  zero.reset(0);
  assert.equal(zero.next(), firstZero);
});

test('same seed rebuilds the same shuffled marble order and initialization random values', () => {
  const createPhysics = () => {
    const positions = new Map();
    return {
      loadStage() {},
      clearMarbles() {
        positions.clear();
      },
      createMarble(id, x, y) {
        positions.set(id, { x, y, angle: 0 });
      },
      getMarblePosition(id) {
        return positions.get(id);
      },
      shakeMarble() {},
      getEntityRenderStates() {
        return [];
      },
    };
  };
  const participants = [
    { name: 'Alice', weight: 0.1, count: 2 },
    { name: 'Bob', weight: 1, count: 2 },
  ];
  const spawn = [
    { x: 1, y: 1 },
    { x: 2, y: 1 },
    { x: 3, y: 1 },
    { x: 4, y: 1 },
  ];
  const makeSnapshot = () => {
    const simulation = new RaceSimulation(createPhysics(), 'same-seed');
    simulation.loadStage({ finish: { y: 100 }, entities: [] });
    simulation.replaceMarbles(participants, 4, spawn);
    return simulation.getRenderStates(0).marbles.map(({ id, coolTime, position }) => ({ id, coolTime, position }));
  };

  assert.deepEqual(makeSnapshot(), makeSnapshot());
});

test('setSeed supports deterministic rebuild and auto-seed replay', () => {
  const createPhysics = () => {
    const positions = new Map();
    return {
      loadStage() {},
      clearMarbles() {
        positions.clear();
      },
      createMarble(id, x, y) {
        positions.set(id, { x, y, angle: 0 });
      },
      getMarblePosition(id) {
        return positions.get(id);
      },
      shakeMarble() {},
      getEntityRenderStates() {
        return [];
      },
    };
  };
  const stage = { finish: { y: 100 }, entities: [] };
  const participants = [{ name: 'Alice', weight: 1, count: 2 }];
  const spawn = [
    { x: 1, y: 1 },
    { x: 2, y: 1 },
  ];
  const snapshot = (simulation) =>
    simulation.getRenderStates(0).marbles.map(({ id, coolTime, position }) => ({ id, coolTime, position }));

  const simulation = new RaceSimulation(createPhysics(), 'api-seed');
  assert.equal(simulation.getSeedMode(), 'explicit');
  simulation.loadStage(stage);
  simulation.replaceMarbles(participants, 2, spawn);
  const first = snapshot(simulation);
  simulation.setSeed('api-seed');
  simulation.replaceMarbles(participants, 2, spawn);
  assert.deepEqual(snapshot(simulation), first);
  simulation.setSeed('other-api-seed');
  simulation.replaceMarbles(participants, 2, spawn);
  assert.notDeepEqual(snapshot(simulation), first);

  simulation.useRandomSeed();
  assert.equal(simulation.getSeedMode(), 'random');
  assert.equal(simulation.getSeed(), 'other-api-seed');

  const auto = new RaceSimulation(createPhysics());
  assert.equal(auto.getSeedMode(), 'random');
  auto.loadStage(stage);
  auto.replaceMarbles(participants, 2, spawn);
  const generatedSeed = auto.getSeed();
  const autoFirst = snapshot(auto);
  auto.setSeed(generatedSeed);
  auto.replaceMarbles(participants, 2, spawn);
  assert.deepEqual(snapshot(auto), autoFirst);
});

test('RoundSession owns round lifecycle and participant rebuild state', async () => {
  const positions = new Map();
  let loadStageCalls = 0;
  const physics = {
    init: async () => {},
    loadStage() {
      loadStageCalls++;
    },
    clearEntities() {},
    clearMarbles() {
      positions.clear();
    },
    createMarble(id, x, y) {
      positions.set(id, { x, y, angle: 0 });
    },
    getMarblePosition(id) {
      return positions.get(id);
    },
    shakeMarble() {},
    impact() {},
    removeMarble(id) {
      positions.delete(id);
    },
    start() {},
    step() {},
    getEntityRenderStates() {
      return [];
    },
  };
  const stage = {
    finish: { y: 100 },
    camera: { zoomTriggerY: 90 },
    spawn: {
      origin: { x: 10.25, y: 1 },
      maxColumns: 10,
      columnSpacing: 0.6,
      rowSpacing: 1,
      maxUnshiftedRows: 5,
    },
    entities: [],
  };
  const replacementStage = {
    ...stage,
    finish: { y: 120 },
    camera: { zoomTriggerY: 110 },
  };
  const session = new RoundSession(new RaceSimulation(physics, 'round-session-seed'));

  assert.equal(session.roundState, 'initializing');
  assert.equal(session.getSeedMode(), 'explicit');
  session.setSkillsEnabled(false);
  assert.equal(session.getSkillsEnabled(), false);
  session.setSkillsEnabled(true);
  assert.equal(session.getSkillsEnabled(), true);
  assert.equal(session.setParticipants(['Alice']), null);

  await session.init();
  session.loadStage(stage);
  session.markReady();
  assert.equal(session.roundState, 'ready');

  const layout = session.setParticipants(['A/3*2', 'B*3']);
  assert.equal(layout.positions.length, 5);
  assert.equal(session.getCount(), 5);
  assert.equal(session.getSeed(), 'round-session-seed');

  session.setSeed('round-session-seed');
  assert.ok(session.rebuildMarblesForCurrentParticipants());
  assert.equal(loadStageCalls, 1);

  const generation = session.prepareStart();
  assert.equal(session.roundState, 'running');
  assert.ok(generation !== null);
  assert.equal(session.prepareStart(), null);
  assert.equal(session.activate(generation), true);

  session.reset();
  assert.equal(session.roundState, 'ready');
  assert.equal(session.getCount(), 0);
  assert.equal(loadStageCalls, 3);

  const rebuilt = session.setMap(replacementStage);
  assert.equal(rebuilt.positions.length, 5);
  assert.equal(session.getCount(), 5);
  assert.equal(session.currentStage, replacementStage);
  assert.equal(loadStageCalls, 4);
});

test('ready Shuffle uses render-only marble previews and preserves authoritative ordering', async () => {
  const makePhysics = () => {
    const positions = new Map();
    let createMarbleCalls = 0;
    let clearMarblesCalls = 0;
    return {
      init: async () => {},
      loadStage() {},
      clearMarbles() {
        clearMarblesCalls++;
        positions.clear();
      },
      createMarble(id, x, y) {
        createMarbleCalls++;
        positions.set(id, { x, y, angle: 0 });
      },
      getMarblePosition(id) {
        return positions.get(id);
      },
      shakeMarble() {},
      impact() {},
      removeMarble(id) {
        positions.delete(id);
      },
      start() {},
      step() {},
      getEntityRenderStates() {
        return [];
      },
      counters: () => ({ createMarbleCalls, clearMarblesCalls }),
    };
  };
  const stage = {
    finish: { y: 100 },
    camera: { zoomTriggerY: 90 },
    spawn: {
      origin: { x: 10.25, y: 1 },
      maxColumns: 10,
      columnSpacing: 0.6,
      rowSpacing: 1,
      maxUnshiftedRows: 5,
    },
    entities: [],
  };
  const participants = [
    { name: 'A', weight: 1.1, count: 2 },
    { name: 'B', weight: 0.1, count: 1 },
  ];
  const seed = 'preview-only-seed';
  const spawn = getMarbleSpawnLayout(3, stage.spawn);
  const physics = makePhysics();
  const session = new RoundSession(new RaceSimulation(physics, seed));
  await session.init();
  session.loadStage(stage);
  session.markReady();

  session.setParticipants(['A/4*2', 'B']);
  assert.deepEqual(physics.counters(), { createMarbleCalls: 0, clearMarblesCalls: 0 });
  const preview = session.getRenderStates(0).marbles;
  assert.deepEqual(preview, createMarblePreviewStates(participants, 3, spawn.positions, seed));

  session.setParticipants(['A/4*2', 'B']);
  assert.deepEqual(physics.counters(), { createMarbleCalls: 0, clearMarblesCalls: 0 });

  const generation = session.prepareStart();
  assert.notEqual(generation, null);
  assert.deepEqual(physics.counters(), { createMarbleCalls: 3, clearMarblesCalls: 1 });
});

test('presentation-side Math.random calls cannot consume the simulation stream', () => {
  const expected = createSeededRandom('isolated').next();
  const actualSource = createSeededRandom('isolated');
  Math.random();
  Math.random();
  assert.equal(actualSource.next(), expected);
});

test('shuffle uses the injected deterministic source', () => {
  const values = ['A', 'B', 'C', 'D', 'E'];
  assert.deepEqual(shuffle(values, createSeededRandom(42)), shuffle(values, createSeededRandom(42)));
  assert.notDeepEqual(shuffle(values, createSeededRandom(42)), shuffle(values, createSeededRandom(43)));
});

test('race simulation keeps fixed-step budget and whole physics debt', () => {
  assert.equal(getStepBudget(10, 0.2), 50);
  assert.deepEqual(preservePhysicsDebt(170, 10), { debt: 170, remainder: 0 });
  assert.deepEqual(preservePhysicsDebt(175, 10), { debt: 170, remainder: 5 });
});

test('race simulation catches up capped physics debt without changing the fixed step', () => {
  const positions = new Map();
  const stepDurations = [];
  const physics = {
    init: async () => {},
    loadStage() {},
    clearMarbles() {
      positions.clear();
    },
    createMarble(id, x, y) {
      positions.set(id, { x, y, angle: 0 });
    },
    getMarblePosition(id) {
      return positions.get(id);
    },
    shakeMarble() {},
    impact() {},
    removeMarble(id) {
      positions.delete(id);
    },
    start() {},
    step(deltaSeconds) {
      stepDurations.push(deltaSeconds);
    },
    getEntityRenderStates() {
      return [];
    },
  };
  const simulation = new RaceSimulation(physics);
  simulation.loadStage({ finish: { y: 100 }, entities: [] });
  simulation.replaceMarbles([{ name: 'Alice', weight: 1, count: 1 }], 1, [{ x: 1, y: 1 }]);

  const callbacks = {
    onImpact() {},
    onFinish() {},
    afterStep() {
      return 1;
    },
    onStepComplete() {},
  };
  simulation.advance(250, 1, 1, callbacks);
  for (let i = 0; i < 3; i++) simulation.advance(0, 1, 1, callbacks);

  assert.equal(stepDurations.length, 25);
  assert.ok(stepDurations.every((duration) => duration === 0.01));
});

function assertExactTraceEqual(actual, expected, label) {
  const length = Math.min(actual.length, expected.length);
  for (let i = 0; i < length; i++) {
    if (JSON.stringify(actual[i]) !== JSON.stringify(expected[i])) {
      throw new Error(
        `${label} first divergence at step ${i}:\nactual=${JSON.stringify(actual[i])}\nexpected=${JSON.stringify(expected[i])}`
      );
    }
  }
  assert.equal(actual.length, expected.length, `${label} trace length`);
}

test('real Box2D races are bit-identical for the same seed across frame cadences', async () => {
  const stage = {
    title: 'determinism test',
    finish: { y: 2.5 },
    camera: { zoomTriggerY: 2 },
    spawn: {
      origin: { x: 10.25, y: 1 },
      maxColumns: 10,
      columnSpacing: 0.6,
      rowSpacing: 1,
      maxUnshiftedRows: 5,
    },
    entities: [],
  };
  const participants = [
    { name: 'Alice', weight: 0.1, count: 1 },
    { name: 'Bob', weight: 0.5, count: 1 },
    { name: 'Carol', weight: 1, count: 1 },
  ];
  const spawn = [
    { x: 10.25, y: 1 },
    { x: 10.85, y: 1 },
    { x: 11.45, y: 1 },
  ];
  const targetSteps = 160;

  const run = async (frameDeltaAt, presentationDraws = 0) => {
    const seed = 'real-box2d-determinism';
    const simulation = new RaceSimulation(undefined, 'initial-seed');
    // box2d-wasm's Node UMD loader otherwise routes its absolute wasm path
    // through Node's fetch(), which does not support file URLs.
    const originalFetch = globalThis.fetch;
    const originalLog = console.log;
    globalThis.fetch = undefined;
    console.log = () => {};
    try {
      await simulation.init();
    } finally {
      globalThis.fetch = originalFetch;
      console.log = originalLog;
    }
    simulation.loadStage(stage);
    simulation.setSeed(seed);
    simulation.replaceMarbles(participants, 3, spawn);
    simulation.start();

    const finished = [];
    const trace = [];
    const frameDiagnostics = [];
    let frame = 0;
    while (trace.length < targetSteps || simulation.physicsDebt !== 0) {
      if (frame > 2000) throw new Error('determinism test did not settle');
      const beforeSteps = trace.length;
      const alpha = simulation.advance(frameDeltaAt(frame), 1, 1, {
        onImpact() {},
        onFinish(marble) {
          finished.push(marble.id);
        },
        afterStep() {
          return 1;
        },
        onStepComplete() {
          const states = simulation.getRenderStates(0).marbles;
          trace.push({
            step: trace.length,
            active: states.map(({ id, position }) => ({ id, ...position })),
            finished: finished.slice(),
          });
          for (let i = 0; i < presentationDraws; i++) Math.random();
        },
      });
      frameDiagnostics.push({
        frame,
        steps: trace.length - beforeSteps,
        debt: simulation.physicsDebt,
        remainder: simulation.elapsed,
        alpha,
      });
      frame++;
    }

    return {
      trace: trace.slice(0, targetSteps),
      finished,
      result: finished.slice(0, 3),
      frameDiagnostics,
    };
  };

  const run60Hz = await run(() => 1000 / 60);
  const run120Hz = await run(() => 1000 / 120);
  const runWithStall = await run((frame) => (frame === 1 ? 250 : 1000 / 60));
  const runWithPresentationNoise = await run(() => 1000 / 60, 5);

  assertExactTraceEqual(run60Hz.trace, run120Hz.trace, '60Hz vs 120Hz');
  assertExactTraceEqual(run60Hz.trace, runWithStall.trace, '60Hz vs stalled');
  assertExactTraceEqual(run60Hz.trace, runWithPresentationNoise.trace, 'simulation vs presentation noise');
  assert.deepEqual(run60Hz.finished, run120Hz.finished);
  assert.deepEqual(run60Hz.finished, runWithStall.finished);
  assert.deepEqual(run60Hz.finished, runWithPresentationNoise.finished);
  assert.deepEqual(run60Hz.result, run120Hz.result);
  assert.deepEqual(run60Hz.result, runWithStall.result);
  assert.equal(run60Hz.finished.length, 3);

  for (const result of [run60Hz, run120Hz, runWithStall]) {
    assert.ok(result.frameDiagnostics.every(({ alpha }) => alpha >= 0 && alpha < 1));
    assert.equal(result.frameDiagnostics.at(-1).debt, 0);
  }
  assert.ok(runWithStall.frameDiagnostics.some(({ steps }) => steps > 1));
  assert.equal(runWithStall.frameDiagnostics.find(({ frame }) => frame === 1).steps, 8);
  assert.ok(runWithStall.frameDiagnostics.find(({ frame }) => frame === 1).debt > 0);
});

test('repeated replay rebuilds on one real Box2D simulation are bit-identical', async () => {
  const stage = {
    title: 'replay lifecycle determinism test',
    finish: { y: 2.5 },
    camera: { zoomTriggerY: 2 },
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
        position: { x: 10.85, y: 1.8 },
        shape: { type: 'box', halfWidth: 1, halfHeight: 0.1, rotation: 0 },
        props: { restitution: 0, destroyOnContact: true },
      },
    ],
  };
  const participants = [
    { name: 'Alice', weight: 0.1, count: 1 },
    { name: 'Bob', weight: 0.5, count: 1 },
    { name: 'Carol', weight: 1, count: 1 },
  ];
  const spawn = [
    { x: 10.25, y: 1 },
    { x: 10.85, y: 1 },
    { x: 11.45, y: 1 },
  ];
  const seed = 'repeated-replay';
  const targetSteps = 160;
  const simulation = new RaceSimulation(undefined, 'initial-seed');

  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = undefined;
  console.log = () => {};
  try {
    await simulation.init();
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }

  const run = () => {
    simulation.resetTiming();
    simulation.loadStage(stage);
    simulation.setSeed(seed);
    simulation.setSkillsEnabled(true);
    simulation.replaceMarbles(participants, 3, spawn);
    simulation.start();

    const finished = [];
    const trace = [];
    let steps = 0;
    let firstFrameSteps;
    let frame = 0;
    while (trace.length < targetSteps || simulation.physicsDebt !== 0) {
      if (trace.length > 2000) throw new Error('repeated replay test did not settle');
      const stepsBeforeFrame = steps;
      simulation.advance(1000 / 60, 1, 1, {
        onImpact() {},
        onFinish(marble) {
          finished.push(marble.id);
        },
        afterStep() {
          return trace.length < targetSteps - 1 ? 1 : 0.2;
        },
        onStepComplete() {
          steps++;
          const states = simulation.getRenderStates(0).marbles;
          trace.push({
            step: trace.length,
            active: states.map(({ id, position }) => ({ id, ...position })),
            finished: finished.slice(),
          });
        },
      });
      if (frame === 0) firstFrameSteps = steps - stepsBeforeFrame;
      frame++;
    }

    return {
      trace: trace.slice(0, targetSteps),
      finished,
      debt: simulation.physicsDebt,
      firstFrameSteps,
    };
  };

  const runs = [run(), run(), run()];
  assertExactTraceEqual(runs[1].trace, runs[0].trace, 'replay run 2');
  assertExactTraceEqual(runs[2].trace, runs[0].trace, 'replay run 3');
  assert.deepEqual(runs[1].finished, runs[0].finished);
  assert.deepEqual(runs[2].finished, runs[0].finished);
  assert.equal(runs[0].finished.length, 3);
  assert.equal(runs[0].firstFrameSteps, 1);
  assert.equal(runs[1].firstFrameSteps, 1);
  assert.equal(runs[2].firstFrameSteps, 1);
  assert.equal(runs[0].debt, 0);
  assert.equal(runs[1].debt, 0);
  assert.equal(runs[2].debt, 0);
});

function fairnessCanonicalStage() {
  return {
    title: 'fairness canonical rebuild test',
    finish: { y: 3.5 },
    camera: { zoomTriggerY: 3 },
    spawn: {
      origin: { x: 10.25, y: 1 },
      maxColumns: 10,
      columnSpacing: 0.6,
      rowSpacing: 1,
      maxUnshiftedRows: 5,
    },
    entities: [
      {
        type: 'kinematic',
        position: { x: 10.85, y: 2.1 },
        shape: { type: 'box', halfWidth: 1.2, halfHeight: 0.1, rotation: 0 },
        props: { angularVelocity: 3.5, restitution: 0 },
      },
      {
        type: 'static',
        position: { x: 10.85, y: 2.8 },
        shape: { type: 'circle', radius: 0.12 },
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

test('Fairness canonical rebuild makes delayed visible state match fresh headless state', async () => {
  const stage = fairnessCanonicalStage();
  const participants = [
    { name: 'A', weight: 0.1, count: 1 },
    { name: 'B', weight: 0.5, count: 1 },
    { name: 'C', weight: 1, count: 1 },
  ];
  const spawnPositions = [
    { x: 10.25, y: 1 },
    { x: 10.85, y: 1 },
    { x: 11.45, y: 1 },
  ];
  const seed = 'fairness-canonical-seed';
  const simulations = [];

  await withNodeBox2d(async () => {
    const createSession = async () => {
      const simulation = new RaceSimulation(undefined, seed);
      const session = new RoundSession(simulation);
      simulations.push(simulation);
      await session.init();
      session.loadStage(stage);
      session.markReady();
      session.setSkillsEnabled(false);
      session.setParticipants(['A', 'B', 'C']);
      return session;
    };
    const runSession = (session, targetRank) => {
      const generation = session.prepareStart();
      assert.notEqual(generation, null);
      assert.equal(session.activate(generation), true);
      const finished = [];
      for (let frame = 0; finished.length <= targetRank; frame++) {
        if (frame > 1000) throw new Error('canonical fairness race did not settle');
        session.advance(80, 1, 1, {
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
    };

    try {
      const delayed = await createSession();
      const initialEntities = delayed.getRenderStates(0).entities;
      for (let frame = 0; frame < 20; frame++) {
        delayed.advance(80, 1, 1, {
          onImpact() {},
          onFinish() {},
          afterStep() {
            return 1;
          },
          onStepComplete() {},
        });
      }
      const advancedEntities = delayed.getRenderStates(0).entities;
      assert.notEqual(advancedEntities[0].angle, initialEntities[0].angle);

      delayed.rebuildAuthoritativeRoundForCurrentParticipants();
      assert.deepEqual(delayed.getRenderStates(0).entities, initialEntities);
      const delayedResult = runSession(delayed, 2);

      const immediate = await createSession();
      immediate.rebuildAuthoritativeRoundForCurrentParticipants();
      const immediateResult = runSession(immediate, 2);
      const headlessResult = await simulateHeadlessRace({
        seed,
        stage,
        participants,
        totalCount: 3,
        spawnPositions,
        skillsEnabled: false,
        targetRank: 2,
      });

      assert.deepEqual(delayedResult, immediateResult);
      assert.deepEqual(delayedResult, headlessResult.finishedMarbleIds);
    } finally {
      simulations.forEach((simulation) => simulation.dispose());
    }
  });
});

test('Fairness prepared seed confirms against the canonical visible race', async () => {
  await withNodeBox2d(async () => {
    const stage = searchTestStage();
    const participantInputs = ['A', 'B'];
    const participants = [
      { name: 'A', weight: 1, count: 1 },
      { name: 'B', weight: 1, count: 1 },
    ];
    const spawnPositions = [
      { x: 10.25, y: 1 },
      { x: 10.85, y: 1 },
    ];
    const physicalRequest = (seed) => ({
      seed,
      stage,
      participants,
      totalCount: 2,
      spawnPositions,
      skillsEnabled: false,
      targetRank: 0,
    });

    let candidateSeed;
    for (let index = 0; index < 64 && candidateSeed === undefined; index++) {
      const seed = `canonical-confirm-${index}`;
      const result = await runHeadlessRace(physicalRequest(seed));
      const mapping = mapMarbleIdsToParticipants(seed, [
        { participantId: 'entry-0', count: 1 },
        { participantId: 'entry-1', count: 1 },
      ]);
      if (mapping.get(result[0]) === 'entry-1') candidateSeed = seed;
    }
    assert.notEqual(candidateSeed, undefined);

    let id = 0;
    const coordinator = new FairnessCoordinator({
      store: new InMemoryFairnessStore(),
      headlessRunner: (request, options) => runHeadlessRace(request, 30000, options),
      createCandidateSeed: () => candidateSeed,
      createId: (prefix) => `${prefix}-${++id}`,
      now: () => id,
    });
    coordinator.setCurrentParticipantInputs(participantInputs);
    await coordinator.setEnabled(true);

    const request = {
      stage,
      mapIndex: 0,
      participantInputs,
      winnerRange: { start: 0, end: 0 },
      skillsEnabled: false,
      currentSeed: 'unused-current-seed',
    };
    const ordinary = await coordinator.prepareUnconstrainedDraw({ ...request, currentSeed: 'ordinary-seed' });
    const aWinner = ordinary.event.entries.find(({ displayName }) => displayName === 'A').marbleIds;
    assert.equal((await coordinator.confirmDraw(ordinary.drawId, aWinner, null)).confirmed, true);

    const prepared = await coordinator.prepareDraw(request, coordinator.beginStart());
    assert.equal(prepared.seed, candidateSeed);

    const simulation = new RaceSimulation(undefined, prepared.seed);
    const session = new RoundSession(simulation);
    try {
      await session.init();
      session.loadStage(stage);
      session.markReady();
      session.setSkillsEnabled(false);
      session.setParticipants(participantInputs);
      session.setSeed(prepared.seed);
      assert.ok(session.rebuildAuthoritativeRoundForCurrentParticipants());

      const generation = session.prepareStart();
      assert.notEqual(generation, null);
      assert.equal(session.activate(generation), true);
      let finish = null;
      for (let frame = 0; finish === null; frame++) {
        if (frame > 1000) throw new Error('canonical confirmation race did not settle');
        session.advance(80, 1, 1, {
          onImpact() {},
          onFinish() {},
          afterStep() {
            return 1;
          },
          onStepComplete() {},
        });
        finish = session.checkFinish();
      }

      const confirmation = await coordinator.confirmDraw(
        prepared.drawId,
        finish.result.map((marble) => marble.id),
        prepared.operationToken,
        prepared.expectedWinnerParticipantIds,
        prepared.expectedWinnerMarbleIds,
        prepared.expectedWinnerEntryIds
      );
      assert.equal(confirmation.confirmed, true);
      const state = await coordinator.getState();
      assert.equal(state.recentDraws[0].status, 'confirmed');
    } finally {
      simulation.dispose();
    }
  });
});

test('Fairness worker warm-up waits for runtime initialization and classifies init failure', async () => {
  const originalWorker = globalThis.Worker;
  const originalNavigator = globalThis.navigator;
  const workerSource = fs.readFileSync(path.resolve('src/fairnessWorker.ts'), 'utf8');
  assert.ok(
    workerSource.indexOf('await simulation.init()') < workerSource.indexOf("scope.postMessage({ type: 'ready' })")
  );

  class FakeWorker {
    static instances = [];

    constructor() {
      this.onmessage = null;
      this.onerror = null;
      this.messages = [];
      this.terminated = false;
      FakeWorker.instances.push(this);
    }

    postMessage(message) {
      this.messages.push(message);
    }

    emit(data) {
      this.onmessage?.({ data });
    }

    terminate() {
      this.terminated = true;
    }
  }

  const request = {
    seed: 'worker-test-seed',
    stage: searchTestStage(),
    participants: [],
    totalCount: 0,
    spawnPositions: [],
    skillsEnabled: false,
    targetRank: 0,
  };

  globalThis.Worker = FakeWorker;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { hardwareConcurrency: 8 } });
  try {
    const pool = new FairnessWorkerPool();
    let warmUpSettled = false;
    const warmUp = pool.warmUp().then(() => {
      warmUpSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(warmUpSettled, false);
    assert.equal(FakeWorker.instances.length, 1);
    FakeWorker.instances[0].emit({ type: 'ready' });
    await warmUp;
    assert.equal(warmUpSettled, true);
    assert.equal(pool.readyConcurrency, 1);

    // Progressive warm-up is readiness-gated: a later WASM init must not
    // overlap an earlier one. The first worker is usable immediately, while
    // each subsequent worker is created only after its predecessor is ready.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(FakeWorker.instances.length, Math.min(2, pool.concurrency));
    if (pool.concurrency > 1) {
      assert.equal(pool.readyConcurrency, 1);
      FakeWorker.instances[1].emit({ type: 'ready' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(FakeWorker.instances.length, Math.min(3, pool.concurrency));
      assert.equal(pool.readyConcurrency, 2);
    }
    FakeWorker.instances.slice(2).forEach((worker) => worker.emit({ type: 'ready' }));
    assert.equal(pool.readyConcurrency, Math.min(3, pool.concurrency));

    const run = pool.run(request, { stepLimit: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const runMessage = FakeWorker.instances[0].messages.find(({ type }) => type === 'run');
    FakeWorker.instances[0].emit({ type: 'result', jobId: runMessage.jobId, finishedMarbleIds: [0] });
    assert.deepEqual(await run, [0]);

    FakeWorker.instances = [];
    const runtimeFailurePool = new FairnessWorkerPool();
    const runtimeReady = runtimeFailurePool.warmUp();
    await new Promise((resolve) => setTimeout(resolve, 0));
    FakeWorker.instances[0].emit({ type: 'ready' });
    await runtimeReady;
    await new Promise((resolve) => setTimeout(resolve, 20));
    FakeWorker.instances[1]?.emit({ type: 'ready' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    FakeWorker.instances[2]?.emit({ type: 'ready' });
    const runtimeRun = runtimeFailurePool.run(request, { stepLimit: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const runtimeRunMessage = FakeWorker.instances[0].messages.find(({ type }) => type === 'run');
    FakeWorker.instances[0].emit({ type: 'initError', message: 'WASM runtime failed' });
    await assert.rejects(runtimeRun, (error) => error instanceof WorkerPoolUnavailableError);
    assert.equal(
      FakeWorker.instances.every(({ terminated }) => terminated),
      true
    );
    await assert.rejects(
      () => runtimeFailurePool.run(request, { stepLimit: 1 }),
      (error) => error instanceof WorkerPoolUnavailableError
    );
    assert.ok(runtimeRunMessage);

    FakeWorker.instances = [];
    const failedPool = new FairnessWorkerPool();
    const failedWarmUp = failedPool.warmUp();
    await new Promise((resolve) => setTimeout(resolve, 0));
    FakeWorker.instances.forEach((worker) => worker.emit({ type: 'initError', message: 'WASM init failed' }));
    await assert.rejects(failedWarmUp, (error) => error instanceof WorkerPoolUnavailableError);
    assert.equal(
      FakeWorker.instances.every(({ terminated }) => terminated),
      true
    );
    await assert.rejects(
      () => failedPool.run(request, { stepLimit: 1 }),
      (error) => error instanceof WorkerPoolUnavailableError
    );
  } finally {
    globalThis.Worker = originalWorker;
    if (originalNavigator === undefined) delete globalThis.navigator;
    else Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator });
  }
});

test('Fairness worker plan protocol sends the physical setup once and seeds per job', async () => {
  const originalWorker = globalThis.Worker;
  const originalNavigator = globalThis.navigator;
  class PlanWorker {
    static instances = [];

    constructor() {
      this.onmessage = null;
      this.onerror = null;
      this.messages = [];
      PlanWorker.instances.push(this);
    }

    postMessage(message) {
      this.messages.push(message);
    }

    emit(data) {
      this.onmessage?.({ data });
    }

    terminate() {}
  }

  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: PlanWorker });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { hardwareConcurrency: 1 } });
  try {
    const pool = new FairnessWorkerPool();
    const warmUp = pool.warmUp();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = PlanWorker.instances[0];
    worker.emit({ type: 'ready' });
    await warmUp;

    const plan = {
      planId: 'plan-protocol-test',
      generation: 4,
      stage: searchTestStage(),
      participants: [{ name: 'A', weight: 1, count: 1 }],
      totalCount: 1,
      spawnPositions: [{ x: 10.25, y: 1 }],
      skillsEnabled: false,
      targetRank: 0,
    };
    const configured = pool.configurePlan(plan);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const configureMessage = worker.messages.find(({ type }) => type === 'configurePlan');
    assert.ok(configureMessage);
    assert.deepEqual(configureMessage.requestWithoutSeed, {
      stage: plan.stage,
      participants: plan.participants,
      totalCount: plan.totalCount,
      spawnPositions: plan.spawnPositions,
      skillsEnabled: plan.skillsEnabled,
      targetRank: plan.targetRank,
    });
    worker.emit({ type: 'planReady', planId: plan.planId });
    assert.equal(await configured, plan.planId);

    const run = pool.runPlan(plan.planId, 'candidate-seed', { stepLimit: 1, attemptIndex: 7 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const runMessage = worker.messages.find(({ type }) => type === 'run');
    assert.deepEqual(runMessage, {
      type: 'run',
      jobId: runMessage.jobId,
      planId: plan.planId,
      seed: 'candidate-seed',
      stepLimit: 1,
      attemptIndex: 7,
    });
    assert.equal(Object.hasOwn(runMessage, 'request'), false);
    worker.emit({ type: 'result', jobId: runMessage.jobId, finishedMarbleIds: [0] });
    assert.deepEqual(await run, [0]);
    assert.equal(worker.messages.filter(({ type }) => type === 'configurePlan').length, 1);
    assert.equal(worker.messages.filter(({ type }) => type === 'run').length, 1);
  } finally {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: originalWorker });
    if (originalNavigator === undefined) delete globalThis.navigator;
    else Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator });
  }
});

function fairnessEvent(type, timestamp, details) {
  return { version: 1, eventId: `event-${timestamp}-${type}`, timestamp, type, ...details };
}

function fairnessParticipant(participantId, displayName, marbleId, effectiveBalance, included = true, active = true) {
  return {
    participantId,
    displayName,
    rawInput: displayName,
    weight: 1,
    count: 1,
    marbleIds: [marbleId],
    active,
    excluded: !included,
    included,
    effectiveBalance,
  };
}

test('strict balance selects only the current minimum included participants', () => {
  const evaluation = evaluateStrictBalance([
    { id: 'A', active: true, excluded: false, effectiveBalance: 4 },
    { id: 'B', active: true, excluded: false, effectiveBalance: 3 },
    { id: 'C', active: true, excluded: false, effectiveBalance: 3 },
    { id: 'D', active: true, excluded: false, effectiveBalance: 4 },
    { id: 'E', active: true, excluded: true, effectiveBalance: 0 },
    { id: 'F', active: false, excluded: false, effectiveBalance: 0 },
  ]);

  assert.deepEqual(evaluation.eligibleIds, ['B', 'C']);
  assert.deepEqual(evaluation.activeExcludedIds, ['E']);
  assert.equal(canUseStrictBalanceFastPath(evaluation), false);
  assert.equal(
    canUseStrictBalanceFastPath(
      evaluateStrictBalance([
        { id: 'A', active: true, excluded: false, effectiveBalance: 2 },
        { id: 'B', active: true, excluded: false, effectiveBalance: 2 },
      ])
    ),
    true
  );
  assert.equal(searchBudget(3, 4, 2), 32);
  assert.equal(searchBudget(1000, 10, 1), 2995);
  assert.equal(searchBudget(500, 500, 1), 1497);
  assert.equal(searchBudget(0, 1, 1), 0);
});

test('fairness entry parser keeps physical entries separate from group members', () => {
  assert.deepEqual(parseFairnessEntryName('A'), ['A']);
  assert.deepEqual(parseFairnessEntryName('B+C'), ['B', 'C']);
  assert.deepEqual(parseFairnessEntryName('B + C'), ['B', 'C']);
  const weightedGroup = parseName('B+C/2*3');
  assert.deepEqual(parseFairnessEntryName(weightedGroup.name), ['B', 'C']);
  assert.equal(weightedGroup.weight, 2);
  assert.equal(weightedGroup.count, 3);
  assert.deepEqual(parseFairnessEntryName('B+C'), ['B', 'C']);
  assert.deepEqual(parseFairnessEntryName('C\\+\\+'), ['C++']);
  assert.deepEqual(parseFairnessEntryName('A\\B'), ['A\\B']);
  assert.equal(parseFairnessEntryName('A+'), null);
  assert.equal(parseFairnessEntryName('+B'), null);
  assert.equal(parseFairnessEntryName('A++B'), null);
});

test('strict balance evaluates grouped entries by exact member average', () => {
  const input = (id, effectiveBalance, excluded = false) => ({
    id,
    active: true,
    excluded,
    effectiveBalance,
  });
  const evaluation = evaluateStrictBalanceEntries([
    { id: 'A', members: [input('A', 0)] },
    { id: 'BC', members: [input('B', 0), input('C', 0)] },
    { id: 'D', members: [input('D', 0)] },
  ]);
  assert.deepEqual(evaluation.eligibleEntryIds, ['A', 'BC', 'D']);
  assert.equal(canUseStrictBalanceEntryFastPath(evaluation), true);

  assert.deepEqual(
    evaluateStrictBalanceEntries([
      { id: 'A', members: [input('A', 0)] },
      { id: 'BC', members: [input('B', 1), input('C', 1)] },
      { id: 'D', members: [input('D', 0)] },
    ]).eligibleEntryIds,
    ['A', 'D']
  );
  assert.deepEqual(
    evaluateStrictBalanceEntries([
      { id: 'BC', members: [input('B', 2), input('C', 4)] },
      { id: 'D', members: [input('D', 3)] },
    ]).eligibleEntryIds,
    ['BC', 'D']
  );
  assert.deepEqual(
    evaluateStrictBalanceEntries([
      { id: 'AB', members: [input('A', 0), input('B', 1)] },
      { id: 'CDE', members: [input('C', 0), input('D', 0), input('E', 2)] },
    ]).eligibleEntryIds,
    ['AB']
  );
  const partial = evaluateStrictBalanceEntries([
    { id: 'BC', members: [input('B', 0), input('C', 99, true)] },
    { id: 'D', members: [input('D', 0)] },
    { id: 'E', members: [input('E', 0, true)] },
  ]);
  assert.deepEqual(partial.eligibleEntryIds, ['BC', 'D']);
  assert.deepEqual(partial.ineligibleEntryIds, ['E']);
  assert.equal(canUseStrictBalanceEntryFastPath(partial), false);
});

test('group winner accounting credits every member once and void reverses it', () => {
  const event = (type, timestamp, details) => ({ ...fairnessEvent(type, timestamp, details), version: 2 });
  const members = ['A', 'B', 'C', 'D'].map((participantId) => ({
    participantId,
    displayName: participantId,
    active: true,
    excluded: false,
    included: true,
    effectiveBalance: 0,
  }));
  const entries = [
    { entryId: 'entry-a', displayName: 'A', rawInput: 'A', memberIds: ['A'], weight: 1, count: 1, marbleIds: [0] },
    {
      entryId: 'entry-bc',
      displayName: 'B+C',
      rawInput: 'B+C',
      memberIds: ['B', 'C'],
      weight: 1,
      count: 1,
      marbleIds: [1],
    },
    { entryId: 'entry-d', displayName: 'D', rawInput: 'D', memberIds: ['D'], weight: 1, count: 1, marbleIds: [2] },
  ];
  const prepared = {
    drawId: 'draw-group',
    epochId: 'epoch-1',
    seed: 'group',
    mapIndex: 0,
    mapTitle: 'group',
    rawParticipantInputs: ['A', 'B+C', 'D'],
    winnerRange: { start: 0, end: 0 },
    skillsEnabled: false,
    fairnessEnabledAtDraw: true,
    policy: { id: 'strict-balance-v1', version: 1 },
    members,
    entries,
  };
  const events = [
    event('epochStarted', 1, { epochId: 'epoch-1' }),
    ...members.map((member, index) =>
      event('participantDiscovered', index + 2, {
        participantId: member.participantId,
        displayName: member.displayName,
        active: true,
        excluded: false,
      })
    ),
    event('drawPrepared', 6, prepared),
    event('drawConfirmed', 7, {
      drawId: 'draw-group',
      winners: [
        {
          entryId: 'entry-bc',
          entryDisplayName: 'B+C',
          marbleId: 1,
          members: [
            { participantId: 'B', displayName: 'B' },
            { participantId: 'C', displayName: 'C' },
          ],
        },
      ],
    }),
  ];
  const projection = projectFairnessEvents(events);
  assert.equal(projection.draws[0].entries[1].memberIds.length, 2);
  assert.equal(projection.participants.find(({ id }) => id === 'B').actualWins, 1);
  assert.equal(projection.participants.find(({ id }) => id === 'C').currentEpochWins, 1);
  const voided = projectFairnessEvents([...events, event('drawVoided', 8, { drawId: 'draw-group' })]);
  assert.equal(voided.participants.find(({ id }) => id === 'B').actualWins, 0);
  assert.equal(voided.participants.find(({ id }) => id === 'C').currentEpochWins, 0);
});

test('incremental fairness projection matches a full event replay', () => {
  const event = (type, timestamp, details) => ({ ...fairnessEvent(type, timestamp, details), version: 2 });
  const events = [
    event('epochStarted', 1, { epochId: 'epoch-1' }),
    event('participantDiscovered', 2, { participantId: 'A', displayName: 'A', active: true, excluded: false }),
    event('participantDiscovered', 3, { participantId: 'B', displayName: 'B', active: true, excluded: false }),
    event('participantRenamed', 4, { participantId: 'A', displayName: 'Alpha', rawInput: 'Alpha' }),
    event('participantExclusionChanged', 5, { participantId: 'B', excluded: true }),
    event('participantParticipationChanged', 6, { participantId: 'B', active: false }),
    event('participantParticipationChanged', 7, { participantId: 'B', active: true }),
    event('drawPrepared', 8, {
      drawId: 'draw-1',
      epochId: 'epoch-1',
      seed: 'projection-seed',
      mapIndex: 0,
      mapTitle: 'Projection',
      rawParticipantInputs: ['Alpha', 'B'],
      winnerRange: { start: 0, end: 0 },
      skillsEnabled: false,
      fairnessEnabledAtDraw: true,
      policy: { id: 'strict-balance-v1', version: 1 },
      members: [fairnessParticipant('A', 'Alpha', 0, 0, true), fairnessParticipant('B', 'B', 1, 0, false)],
      entries: [
        {
          entryId: 'entry-a',
          displayName: 'Alpha',
          rawInput: 'Alpha',
          memberIds: ['A'],
          weight: 1,
          count: 1,
          marbleIds: [0],
        },
        { entryId: 'entry-b', displayName: 'B', rawInput: 'B', memberIds: ['B'], weight: 1, count: 1, marbleIds: [1] },
      ],
    }),
    event('drawConfirmed', 9, {
      drawId: 'draw-1',
      winners: [
        {
          entryId: 'entry-a',
          entryDisplayName: 'Alpha',
          marbleId: 0,
          members: [{ participantId: 'A', displayName: 'Alpha' }],
        },
      ],
    }),
    event('drawVoided', 10, { drawId: 'draw-1', reason: 'test' }),
  ];
  const incremental = projectFairnessEvents([]);
  events.forEach((item) => applyFairnessEvent(incremental, item));
  assert.deepEqual(incremental, projectFairnessEvents(events));
});

test('group identity survives regrouping and duplicate member entries are rejected', async () => {
  let id = 0;
  const stage = {
    title: 'group test',
    finish: { y: 20 },
    camera: { zoomTriggerY: 10 },
    spawn: { origin: { x: 10.25, y: 1 }, maxColumns: 10, columnSpacing: 0.6, rowSpacing: 1, maxUnshiftedRows: 5 },
    entities: [],
  };
  const request = (participantInputs) => ({
    stage,
    mapIndex: 0,
    participantInputs,
    winnerRange: { start: 0, end: 0 },
    skillsEnabled: false,
    currentSeed: 'group-test',
  });
  const coordinator = new FairnessCoordinator({
    store: new InMemoryFairnessStore(),
    createId: (prefix) => `${prefix}-${++id}`,
    now: () => id,
  });
  coordinator.setCurrentParticipantInputs(['A', 'B', 'C']);
  await coordinator.setEnabled(true);
  const initial = await coordinator.getState();
  const ids = Object.fromEntries(
    initial.participants.map(({ displayName, id: participantId }) => [displayName, participantId])
  );
  coordinator.setCurrentParticipantInputs(['A', 'B+C', 'D']);
  const grouped = await coordinator.getState();
  assert.equal(grouped.participants.find(({ displayName }) => displayName === 'A').id, ids.A);
  assert.equal(grouped.participants.find(({ displayName }) => displayName === 'B').id, ids.B);
  assert.equal(grouped.participants.find(({ displayName }) => displayName === 'C').id, ids.C);
  ids.D = grouped.participants.find(({ displayName }) => displayName === 'D').id;
  const prepared = await coordinator.prepareDraw(request(['A', 'B+C', 'D']), coordinator.beginStart());
  assert.deepEqual(
    prepared.event.entries.map((entry) => entry.displayName),
    ['A', 'B+C', 'D']
  );
  assert.deepEqual(
    prepared.event.entries[1].memberIds.map(
      (memberId) => prepared.event.members.find((member) => member.participantId === memberId).displayName
    ),
    ['B', 'C']
  );

  coordinator.setCurrentParticipantInputs(['A+B', 'C', 'D']);
  const regrouped = await coordinator.getState();
  assert.equal(regrouped.participants.find(({ displayName }) => displayName === 'A').id, ids.A);
  assert.equal(regrouped.participants.find(({ displayName }) => displayName === 'B').id, ids.B);
  assert.equal(regrouped.participants.find(({ displayName }) => displayName === 'C').id, ids.C);
  await assert.rejects(
    () => coordinator.prepareDraw(request(['A', 'A+B']), coordinator.beginStart()),
    /multiple draw entries/
  );

  await coordinator.renameParticipant(ids.B, 'Bravo');
  coordinator.setCurrentParticipantInputs(['Bravo+C', 'D']);
  const renamed = await coordinator.getState();
  assert.equal(renamed.participants.find(({ displayName }) => displayName === 'Bravo').id, ids.B);
  await assert.rejects(
    () => coordinator.prepareDraw(request(['Bravo', 'B+C']), coordinator.beginStart()),
    /multiple draw entries/
  );
});

test('group search accepts an eligible draw entry and keeps plus literal when fairness is off', async () => {
  const stage = {
    title: 'group search test',
    finish: { y: 20 },
    camera: { zoomTriggerY: 10 },
    spawn: { origin: { x: 10.25, y: 1 }, maxColumns: 10, columnSpacing: 0.6, rowSpacing: 1, maxUnshiftedRows: 5 },
    entities: [],
  };
  const request = (participantInputs, currentSeed) => ({
    stage,
    mapIndex: 0,
    participantInputs,
    winnerRange: { start: 0, end: 0 },
    skillsEnabled: false,
    currentSeed,
  });
  let id = 0;
  const candidateSeeds = ['reject-group', 'accept-singleton'];
  const coordinator = new FairnessCoordinator({
    store: new InMemoryFairnessStore(),
    createId: (prefix) => `${prefix}-${++id}`,
    now: () => id,
    createCandidateSeed: () => candidateSeeds.shift(),
    headlessRunner: async ({ seed }) => {
      const mapping = mapMarbleIdsToParticipants(seed, [
        { participantId: 'entry-0', count: 1 },
        { participantId: 'entry-1', count: 1 },
        { participantId: 'entry-2', count: 1 },
      ]);
      const wanted = seed === 'reject-group' ? 'entry-1' : 'entry-0';
      return [Array.from(mapping.entries()).find(([, entryId]) => entryId === wanted)[0]];
    },
  });
  coordinator.setCurrentParticipantInputs(['A', 'B+C', 'D']);
  await coordinator.setEnabled(true);

  const baseline = await coordinator.prepareUnconstrainedDraw(request(['A', 'B+C', 'D'], 'baseline'));
  const groupWinnerMarble = baseline.event.entries.find(({ entryId }) => entryId === 'entry-1').marbleIds[0];
  await coordinator.confirmDraw(baseline.drawId, [groupWinnerMarble], null);

  const searched = await coordinator.prepareDraw(request(['A', 'B+C', 'D'], 'unused-seed'), coordinator.beginStart());
  assert.equal(searched.seed, 'accept-singleton');
  assert.deepEqual(searched.expectedWinnerEntryIds, ['entry-0']);
  assert.equal(searched.event.entries.length, 3);
  assert.deepEqual(
    searched.event.entries[1].memberIds.map(
      (memberId) => searched.event.members.find((member) => member.participantId === memberId).displayName
    ),
    ['B', 'C']
  );
  assert.equal(
    (
      await coordinator.confirmDraw(
        searched.drawId,
        searched.expectedWinnerMarbleIds,
        searched.operationToken,
        null,
        searched.expectedWinnerMarbleIds,
        searched.expectedWinnerEntryIds
      )
    ).confirmed,
    true
  );
  const state = await coordinator.getState();
  assert.equal(state.participants.find(({ displayName }) => displayName === 'B').currentEpochWins, 1);
  assert.equal(state.participants.find(({ displayName }) => displayName === 'C').currentEpochWins, 1);

  const ordinary = new FairnessCoordinator({ store: new InMemoryFairnessStore() });
  ordinary.setCurrentParticipantInputs(['B+C']);
  const ordinaryDraw = await ordinary.prepareUnconstrainedDraw(request(['B+C'], 'literal-plus'));
  assert.deepEqual(
    ordinaryDraw.event.entries.map(({ displayName }) => displayName),
    ['B+C']
  );
  assert.deepEqual(
    ordinaryDraw.event.members.map(({ displayName }) => displayName),
    ['B+C']
  );
  await ordinary.setEnabled(true);
  const migratedState = await ordinary.getState();
  assert.equal(migratedState.participants.find(({ displayName }) => displayName === 'B+C').active, false);
  assert.equal(migratedState.participants.find(({ displayName }) => displayName === 'B').active, true);
  assert.equal(migratedState.participants.find(({ displayName }) => displayName === 'C').active, true);
});

test('legacy v1 B+C data remains a singleton during v2 migration', () => {
  const legacy = fairnessEvent('drawPrepared', 3, {
    drawId: 'legacy-draw',
    epochId: 'epoch-1',
    seed: 'legacy',
    mapIndex: 0,
    mapTitle: 'legacy',
    rawParticipantInputs: ['B+C'],
    winnerRange: { start: 0, end: 0 },
    skillsEnabled: false,
    fairnessEnabledAtDraw: false,
    policy: { id: 'strict-balance-v1', version: 1 },
    participants: [fairnessParticipant('legacy-member', 'B+C', 0, 0)],
  });
  const migrated = validateFairnessExport({
    version: LEGACY_FAIRNESS_DATA_VERSION,
    mode: 'complete',
    events: [
      fairnessEvent('epochStarted', 1, { epochId: 'epoch-1' }),
      fairnessEvent('participantDiscovered', 2, {
        participantId: 'legacy-member',
        displayName: 'B+C',
        active: true,
        excluded: false,
      }),
      legacy,
    ],
  });
  const migratedDraw = migrated.events.find(({ type }) => type === 'drawPrepared');
  assert.equal(migrated.version, 2);
  assert.deepEqual(
    migratedDraw.members.map(({ displayName }) => displayName),
    ['B+C']
  );
  assert.deepEqual(migratedDraw.entries[0].memberIds, ['legacy-member']);
});

test('fairness projection separates confirmed, voided, excluded, and rejoined history', () => {
  const events = [
    fairnessEvent('epochStarted', 1, { epochId: 'epoch-1' }),
    fairnessEvent('participantDiscovered', 2, { participantId: 'A', displayName: 'A', active: true, excluded: false }),
    fairnessEvent('participantDiscovered', 3, { participantId: 'B', displayName: 'B', active: true, excluded: false }),
    fairnessEvent('drawPrepared', 4, {
      drawId: 'draw-1',
      epochId: 'epoch-1',
      seed: 'one',
      mapIndex: 0,
      mapTitle: 'test',
      rawParticipantInputs: ['A', 'B'],
      winnerRange: { start: 0, end: 0 },
      skillsEnabled: true,
      fairnessEnabledAtDraw: false,
      policy: { id: 'strict-balance-v1', version: 1 },
      participants: [fairnessParticipant('A', 'A', 0, 0), fairnessParticipant('B', 'B', 1, 0)],
    }),
    fairnessEvent('drawConfirmed', 5, {
      drawId: 'draw-1',
      winners: [{ participantId: 'A', displayName: 'A', marbleId: 0 }],
    }),
    fairnessEvent('participantParticipationChanged', 6, { participantId: 'A', active: false }),
    fairnessEvent('drawPrepared', 7, {
      drawId: 'draw-2',
      epochId: 'epoch-1',
      seed: 'two',
      mapIndex: 0,
      mapTitle: 'test',
      rawParticipantInputs: ['B'],
      winnerRange: { start: 0, end: 0 },
      skillsEnabled: true,
      fairnessEnabledAtDraw: false,
      policy: { id: 'strict-balance-v1', version: 1 },
      participants: [fairnessParticipant('B', 'B', 0, 0)],
    }),
    fairnessEvent('drawConfirmed', 8, {
      drawId: 'draw-2',
      winners: [{ participantId: 'B', displayName: 'B', marbleId: 0 }],
    }),
    fairnessEvent('participantParticipationChanged', 9, { participantId: 'A', active: true }),
    fairnessEvent('participantDiscovered', 10, { participantId: 'C', displayName: 'C', active: true, excluded: false }),
    fairnessEvent('participantExclusionChanged', 11, { participantId: 'B', excluded: true }),
    fairnessEvent('drawPrepared', 12, {
      drawId: 'draw-3',
      epochId: 'epoch-1',
      seed: 'three',
      mapIndex: 0,
      mapTitle: 'test',
      rawParticipantInputs: ['A', 'B', 'C'],
      winnerRange: { start: 0, end: 0 },
      skillsEnabled: true,
      fairnessEnabledAtDraw: true,
      policy: { id: 'strict-balance-v1', version: 1 },
      participants: [
        fairnessParticipant('A', 'A', 0, 1),
        fairnessParticipant('B', 'B', 1, 1, false),
        fairnessParticipant('C', 'C', 2, 1),
      ],
    }),
    fairnessEvent('drawConfirmed', 13, {
      drawId: 'draw-3',
      winners: [{ participantId: 'B', displayName: 'B', marbleId: 1 }],
    }),
    fairnessEvent('drawVoided', 14, { drawId: 'draw-1', reason: 'test' }),
  ];

  const projection = projectFairnessEvents(events);
  const participantA = projection.participants.find(({ id }) => id === 'A');
  const participantB = projection.participants.find(({ id }) => id === 'B');
  const participantC = projection.participants.find(({ id }) => id === 'C');
  assert.deepEqual(participantA, {
    id: 'A',
    displayName: 'A',
    createdAt: 2,
    active: true,
    excluded: false,
    actualWins: 0,
    fairnessCountedWins: 0,
    currentEpochWins: 0,
    effectiveBalance: 0,
    previousEffectiveBalance: 1,
    participationHistory: [
      { timestamp: 2, active: true },
      { timestamp: 6, active: false },
      { timestamp: 9, active: true },
    ],
  });
  assert.equal(participantB.actualWins, 2);
  assert.equal(participantB.currentEpochWins, 1);
  assert.equal(participantB.effectiveBalance, 1);
  assert.equal(participantC.effectiveBalance, 1);
  assert.equal(projection.draws.find(({ id }) => id === 'draw-1').status, 'voided');
  assert.equal(projection.draws.find(({ id }) => id === 'draw-3').status, 'confirmed');
});

test('fairness export validates and round-trips draw metadata without mutating the source', () => {
  const event = fairnessEvent('epochStarted', 1, { epochId: 'epoch-1' });
  const exported = createFairnessExport([event], 'complete');
  const roundTrip = validateFairnessExport(JSON.parse(JSON.stringify(exported)));
  assert.deepEqual(roundTrip, exported);
  assert.notEqual(roundTrip.events, exported.events);
  assert.throws(() => validateFairnessExport({ ...exported, version: 3 }), /unsupported export version/);
});

test('fairness export rejects inconsistent draw snapshots', () => {
  const baseEvents = [
    fairnessEvent('epochStarted', 1, { epochId: 'epoch-1' }),
    fairnessEvent('participantDiscovered', 2, { participantId: 'A', displayName: 'A', active: true, excluded: false }),
  ];
  const draw = {
    drawId: 'draw-1',
    epochId: 'epoch-1',
    seed: 'seed',
    mapIndex: 0,
    mapTitle: 'test',
    rawParticipantInputs: ['A'],
    winnerRange: { start: 0, end: 0 },
    skillsEnabled: false,
    fairnessEnabledAtDraw: true,
    policy: { id: 'strict-balance-v1', version: 1 },
    participants: [fairnessParticipant('A', 'A', 0, 0)],
  };
  const prepared = fairnessEvent('drawPrepared', 3, draw);
  const valid = (events) => validateFairnessExport({ version: 1, mode: 'complete', events });

  assert.throws(
    () => valid([...baseEvents, fairnessEvent('drawPrepared', 3, { ...draw, participants: [] })]),
    /participant snapshot is empty/
  );
  assert.throws(
    () =>
      valid([
        ...baseEvents,
        fairnessEvent('drawPrepared', 3, {
          ...draw,
          participants: [{ ...draw.participants[0], count: 2 }],
        }),
      ]),
    /participant snapshot is invalid/
  );
  assert.throws(
    () =>
      valid([
        ...baseEvents,
        prepared,
        fairnessEvent('drawConfirmed', 4, {
          drawId: 'draw-1',
          winners: [{ participantId: 'A', displayName: 'A', marbleId: 1 }],
        }),
      ]),
    /winner marble is not in the prepared participant snapshot/
  );
});

test('fairness history deduplicates one participant with multiple winning marbles', () => {
  const events = [
    fairnessEvent('epochStarted', 1, { epochId: 'epoch-1' }),
    fairnessEvent('participantDiscovered', 2, { participantId: 'A', displayName: 'A', active: true, excluded: false }),
    fairnessEvent('drawPrepared', 3, {
      drawId: 'draw-1',
      epochId: 'epoch-1',
      seed: 'seed',
      mapIndex: 0,
      mapTitle: 'test',
      rawParticipantInputs: ['A*2'],
      winnerRange: { start: 0, end: 1 },
      skillsEnabled: true,
      fairnessEnabledAtDraw: false,
      policy: { id: 'strict-balance-v1', version: 1 },
      participants: [
        {
          ...fairnessParticipant('A', 'A', 0, 0),
          count: 2,
          marbleIds: [0, 1],
        },
      ],
    }),
    fairnessEvent('drawConfirmed', 4, {
      drawId: 'draw-1',
      winners: [
        { participantId: 'A', displayName: 'A', marbleId: 0 },
        { participantId: 'A', displayName: 'A', marbleId: 1 },
      ],
    }),
  ];
  const participant = projectFairnessEvents(events).participants[0];
  assert.equal(participant.actualWins, 1);
  assert.equal(participant.fairnessCountedWins, 1);
});

test('fairness starts a new epoch without deleting lifetime history', () => {
  const events = [
    fairnessEvent('epochStarted', 1, { epochId: 'epoch-1' }),
    fairnessEvent('participantDiscovered', 2, { participantId: 'A', displayName: 'A', active: true, excluded: false }),
    fairnessEvent('drawPrepared', 3, {
      drawId: 'draw-1',
      epochId: 'epoch-1',
      seed: 'seed',
      mapIndex: 0,
      mapTitle: 'test',
      rawParticipantInputs: ['A'],
      winnerRange: { start: 0, end: 0 },
      skillsEnabled: true,
      fairnessEnabledAtDraw: false,
      policy: { id: 'strict-balance-v1', version: 1 },
      participants: [fairnessParticipant('A', 'A', 0, 0)],
    }),
    fairnessEvent('drawConfirmed', 4, {
      drawId: 'draw-1',
      winners: [{ participantId: 'A', displayName: 'A', marbleId: 0 }],
    }),
    fairnessEvent('epochStarted', 5, { epochId: 'epoch-2' }),
  ];
  const participant = projectFairnessEvents(events).participants[0];
  assert.equal(participant.actualWins, 1);
  assert.equal(participant.fairnessCountedWins, 1);
  assert.equal(participant.currentEpochWins, 0);
  assert.equal(participant.effectiveBalance, 0);
});

test('new fairness epochs do not carry an inactive participant balance into rejoin', () => {
  const events = [
    fairnessEvent('epochStarted', 1, { epochId: 'epoch-1' }),
    fairnessEvent('participantDiscovered', 2, { participantId: 'A', displayName: 'A', active: true, excluded: false }),
    fairnessEvent('participantDiscovered', 3, { participantId: 'B', displayName: 'B', active: true, excluded: false }),
    fairnessEvent('drawPrepared', 4, {
      drawId: 'draw-1',
      epochId: 'epoch-1',
      seed: 'seed',
      mapIndex: 0,
      mapTitle: 'test',
      rawParticipantInputs: ['A', 'B'],
      winnerRange: { start: 0, end: 0 },
      skillsEnabled: true,
      fairnessEnabledAtDraw: false,
      policy: { id: 'strict-balance-v1', version: 1 },
      participants: [fairnessParticipant('A', 'A', 0, 0), fairnessParticipant('B', 'B', 1, 0)],
    }),
    fairnessEvent('drawConfirmed', 5, {
      drawId: 'draw-1',
      winners: [{ participantId: 'B', displayName: 'B', marbleId: 1 }],
    }),
    fairnessEvent('participantParticipationChanged', 6, { participantId: 'B', active: false }),
    fairnessEvent('epochStarted', 7, { epochId: 'epoch-2' }),
    fairnessEvent('participantParticipationChanged', 8, { participantId: 'B', active: true }),
  ];

  const projection = projectFairnessEvents(events);
  const participantB = projection.participants.find(({ id }) => id === 'B');
  assert.equal(participantB.effectiveBalance, 0);
  assert.equal(participantB.previousEffectiveBalance, 0);
  assert.equal(participantB.actualWins, 1);
});

test('fairness participant rename keeps identity across a fresh coordinator', async () => {
  let id = 0;
  const store = new InMemoryFairnessStore();
  const makeCoordinator = () =>
    new FairnessCoordinator({
      store,
      createId: (prefix) => `${prefix}-${++id}`,
      now: () => id,
    });

  const first = makeCoordinator();
  first.setCurrentParticipantInputs(['A', 'B']);
  await first.setEnabled(true);
  const firstState = await first.getState();
  const participantA = firstState.participants.find(({ displayName }) => displayName === 'A');
  await first.renameParticipant(participantA.id, 'Alice');

  const second = makeCoordinator();
  second.setCurrentParticipantInputs(['B', 'A']);
  await second.setEnabled(true);
  const secondState = await second.getState();
  const renamed = secondState.participants.find(({ displayName }) => displayName === 'Alice');
  assert.equal(renamed.id, participantA.id);
  assert.equal(secondState.participants.length, 2);
});

test('fairness participant identity survives temporary absence and rejoin', async () => {
  let id = 0;
  const coordinator = new FairnessCoordinator({
    store: new InMemoryFairnessStore(),
    createId: (prefix) => `${prefix}-${++id}`,
    now: () => id,
  });

  coordinator.setCurrentParticipantInputs(['A', 'B', 'C']);
  await coordinator.setEnabled(true);
  const initial = await coordinator.getState();
  const initialC = initial.participants.find(({ displayName }) => displayName === 'C');

  coordinator.setCurrentParticipantInputs(['A', 'B']);
  await coordinator.getState();
  coordinator.setCurrentParticipantInputs(['A', 'B', 'C']);
  const rejoined = await coordinator.getState();
  const rejoinedC = rejoined.participants.find(({ displayName }) => displayName === 'C');

  assert.equal(rejoinedC.id, initialC.id);
  assert.equal(rejoinedC.active, true);
  assert.equal(rejoinedC.actualWins, 0);
  assert.equal(rejoinedC.participationHistory.filter(({ active }) => active === false).length, 1);
});

test('renamed participant identity survives temporary absence and rejoin', async () => {
  let id = 0;
  const coordinator = new FairnessCoordinator({
    store: new InMemoryFairnessStore(),
    createId: (prefix) => `${prefix}-${++id}`,
    now: () => id,
  });

  coordinator.setCurrentParticipantInputs(['A', 'B']);
  await coordinator.setEnabled(true);
  const initial = await coordinator.getState();
  const initialA = initial.participants.find(({ displayName }) => displayName === 'A');
  await coordinator.renameParticipant(initialA.id, 'Alice');

  coordinator.setCurrentParticipantInputs(['B']);
  await coordinator.getState();
  coordinator.setCurrentParticipantInputs(['B', 'A']);
  const rejoined = await coordinator.getState();
  const rejoinedA = rejoined.participants.find(({ displayName }) => displayName === 'Alice');

  assert.equal(rejoinedA.id, initialA.id);
  assert.equal(rejoinedA.active, true);
});

test('fairness coordinator records ordinary draws while disabled and searches only when enabled', async () => {
  const stage = {
    title: 'fairness test',
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
  const request = (seed) => ({
    stage,
    mapIndex: 0,
    participantInputs: ['A', 'B'],
    winnerRange: { start: 0, end: 0 },
    skillsEnabled: true,
    currentSeed: seed,
  });
  let id = 0;
  const ordinary = new FairnessCoordinator({
    store: new InMemoryFairnessStore(),
    createId: (prefix) => `${prefix}-${++id}`,
    now: () => id,
  });
  ordinary.setCurrentParticipantInputs(['A', 'B']);
  const ordinaryToken = ordinary.beginStart();
  const ordinaryDraw = await ordinary.prepareUnconstrainedDraw(request('ordinary'), ordinaryToken);
  assert.ok(ordinaryDraw);
  const ordinaryWinner = ordinaryDraw.event.entries.find(({ displayName }) => displayName === 'A').marbleIds[0];
  assert.equal((await ordinary.confirmDraw(ordinaryDraw.drawId, [ordinaryWinner], ordinaryToken)).confirmed, true);
  const ordinaryState = await ordinary.getState();
  assert.equal(ordinaryState.enabled, false);
  assert.equal(ordinaryState.recentDraws[0].fairnessEnabledAtDraw, false);
  assert.equal(ordinaryState.participants.find(({ displayName }) => displayName === 'A').actualWins, 1);

  const candidateSeeds = ['bad', 'good'];
  const fairness = new FairnessCoordinator({
    store: new InMemoryFairnessStore(),
    createId: (prefix) => `${prefix}-${++id}`,
    now: () => id,
    createCandidateSeed: () => candidateSeeds.shift(),
    headlessRunner: async ({ seed }) => {
      const mapping = mapMarbleIdsToParticipants(seed, [
        { participantId: participantIds.A, count: 1 },
        { participantId: participantIds.B, count: 1 },
      ]);
      const wanted = seed === 'bad' ? participantIds.A : participantIds.B;
      return [Array.from(mapping.entries()).find(([, participantId]) => participantId === wanted)[0]];
    },
  });
  fairness.setCurrentParticipantInputs(['A', 'B']);
  await fairness.setEnabled(true);
  const fairnessParticipants = await fairness.getState();
  const participantIds = Object.fromEntries(
    fairnessParticipants.participants.map(({ displayName, id }) => [displayName, id])
  );
  const seedToken = fairness.beginStart();
  const firstDraw = await fairness.prepareUnconstrainedDraw(request('baseline'), seedToken);
  const firstWinner = firstDraw.event.entries.find(({ displayName }) => displayName === 'A').marbleIds[0];
  await fairness.confirmDraw(firstDraw.drawId, [firstWinner], seedToken);

  const searchToken = fairness.beginStart();
  const searched = await fairness.prepareDraw(request('unused-seed'), searchToken);
  assert.equal(searched.seed, 'good');
  assert.deepEqual(searched.expectedWinnerParticipantIds, [participantIds.B]);
  assert.equal(
    (
      await fairness.confirmDraw(
        searched.drawId,
        searched.expectedWinnerMarbleIds,
        searchToken,
        [participantIds.B],
        searched.expectedWinnerMarbleIds
      )
    ).confirmed,
    true
  );
  const state = await fairness.getState();
  assert.equal(state.participants.find(({ displayName }) => displayName === 'A').currentEpochWins, 1);
  assert.equal(state.participants.find(({ displayName }) => displayName === 'B').currentEpochWins, 1);
  assert.equal(createFairnessCandidateSeed().startsWith('seed-'), true);
});

test('fairness write failures disable the control plane without hiding the error', async () => {
  const store = new InMemoryFairnessStore();
  store.append = async () => {
    throw new Error('quota exceeded');
  };
  const coordinator = new FairnessCoordinator({ store });
  coordinator.setCurrentParticipantInputs(['A']);

  await assert.rejects(() => coordinator.setEnabled(true), /quota exceeded/);
  const state = await coordinator.getState();
  assert.equal(state.available, false);
  assert.equal(state.enabled, false);
  assert.match(state.error, /quota exceeded/);
});

test('fairness headless runner uses the real Box2D simulation', async () => {
  const request = {
    seed: 'headless-box2d',
    stage: {
      title: 'headless test',
      finish: { y: 2.5 },
      camera: { zoomTriggerY: 2 },
      spawn: {
        origin: { x: 10.25, y: 1 },
        maxColumns: 10,
        columnSpacing: 0.6,
        rowSpacing: 1,
        maxUnshiftedRows: 5,
      },
      entities: [],
    },
    participants: [
      { name: 'A', weight: 0.1, count: 1 },
      { name: 'B', weight: 1, count: 1 },
    ],
    totalCount: 2,
    spawnPositions: [
      { x: 10.25, y: 1 },
      { x: 10.85, y: 1 },
    ],
    skillsEnabled: true,
    targetRank: 0,
  };
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = undefined;
  console.log = () => {};
  try {
    assert.deepEqual(await runHeadlessRace(request), await runHeadlessRace(request));
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});

function cancellableHeadlessRequest(finishY = 1000) {
  return {
    seed: 'cancellable-headless-seed',
    stage: {
      title: 'cancellable headless test',
      finish: { y: finishY },
      camera: { zoomTriggerY: 10 },
      spawn: {
        origin: { x: 10.25, y: 1 },
        maxColumns: 10,
        columnSpacing: 0.6,
        rowSpacing: 1,
        maxUnshiftedRows: 5,
      },
      entities: [],
    },
    participants: [
      { name: 'A', weight: 1, count: 1 },
      { name: 'B', weight: 1, count: 1 },
    ],
    totalCount: 2,
    spawnPositions: [
      { x: 10.25, y: 1 },
      { x: 10.85, y: 1 },
    ],
    skillsEnabled: false,
    targetRank: 0,
  };
}

test('headless simulation rejects an already-aborted signal', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => simulateHeadlessRace(cancellableHeadlessRequest(), { signal: controller.signal }),
    (error) => error instanceof HeadlessSimulationCancelledError
  );
});

test('headless simulation cancels between advances and disposes its RaceSimulation', async () => {
  const controller = new AbortController();
  const originalDispose = RaceSimulation.prototype.dispose;
  let disposeCalls = 0;
  RaceSimulation.prototype.dispose = function () {
    disposeCalls++;
    return originalDispose.call(this);
  };
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = undefined;
  console.log = () => {};
  try {
    const running = simulateHeadlessRace(cancellableHeadlessRequest(), { signal: controller.signal });
    setTimeout(() => controller.abort(), 0);
    await assert.rejects(running, (error) => error instanceof HeadlessSimulationCancelledError);
    assert.equal(disposeCalls, 1);
  } finally {
    RaceSimulation.prototype.dispose = originalDispose;
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});

test('public simulation client is repeatable and isolated from its input', async () => {
  const stage = {
    title: 'public simulation test',
    finish: { y: 2.5 },
    camera: { zoomTriggerY: 2 },
    spawn: {
      origin: { x: 10.25, y: 1 },
      maxColumns: 10,
      columnSpacing: 0.6,
      rowSpacing: 1,
      maxUnshiftedRows: 5,
    },
    entities: [],
  };
  const replay = {
    version: 1,
    seed: 'public-simulation-seed',
    mapIndex: 0,
    participants: ['A*2', 'B'],
    winnerRange: { start: 0, end: 1 },
    skillsEnabled: false,
  };
  const client = new SimulationClient([stage]);
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = undefined;
  console.log = () => {};
  try {
    const first = await client.simulate(replay);
    const second = await client.preview(JSON.parse(JSON.stringify(replay)));
    assert.deepEqual(second, first);
    assert.equal(first.finished.length, 2);
    assert.equal(first.winners.length, 2);
    assert.equal(first.finished.filter(({ name }) => name === 'A').length <= 2, true);

    const liveSimulation = new RaceSimulation(undefined, replay.seed);
    const liveSession = new RoundSession(liveSimulation);
    try {
      await liveSession.init();
      liveSession.markReady();
      liveSession.loadStage(stage);
      liveSession.setSeed(replay.seed);
      liveSession.setSkillsEnabled(replay.skillsEnabled);
      liveSession.setParticipants(replay.participants);
      liveSession.setWinnerRange(replay.winnerRange.start, replay.winnerRange.end);
      const generation = liveSession.prepareStart();
      assert.notEqual(generation, null);
      assert.equal(liveSession.activate(generation), true);

      const liveFinished = [];
      let liveSteps = 0;
      while (liveFinished.length <= replay.winnerRange.end) {
        liveSession.advance(80, 1, 1, {
          onImpact() {},
          onFinish(marble) {
            liveFinished.push({ marbleId: marble.id, name: marble.name });
          },
          afterStep() {
            return 1;
          },
          onStepComplete() {
            liveSteps++;
          },
        });
      }
      assert.deepEqual(first.finished, liveFinished.slice(0, first.finished.length));
      assert.equal(first.steps, liveSteps);
    } finally {
      liveSimulation.dispose();
    }

    const alternate = await client.preview({ ...replay, seed: 'other-public-seed' });
    assert.equal(alternate.replay.seed, 'other-public-seed');
    assert.equal(replay.seed, 'public-simulation-seed');

    assert.equal((await client.verify(replay, first)).matches, true);
    assert.equal((await client.verify(replay, { ...first, steps: first.steps + 1 })).matches, false);
    await assert.rejects(() => client.simulate({ ...replay, version: 2 }), /unsupported version/);
    await assert.rejects(() => client.simulate(replay, { stepLimit: 1 }), /did not reach the requested rank/);
    assert.deepEqual(await client.simulate(replay), first);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});

test('real Box2D winner mapping keeps a grouped entry together', async () => {
  const stage = {
    title: 'group headless test',
    finish: { y: 2.5 },
    camera: { zoomTriggerY: 2 },
    spawn: {
      origin: { x: 10.25, y: 1 },
      maxColumns: 10,
      columnSpacing: 0.6,
      rowSpacing: 1,
      maxUnshiftedRows: 5,
    },
    entities: [],
  };
  const entries = [
    { participantId: 'entry-a', count: 1 },
    { participantId: 'entry-bc', count: 1 },
    { participantId: 'entry-d', count: 1 },
  ];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = undefined;
  console.log = () => {};
  try {
    let groupedWinner = false;
    for (let index = 0; index < 12 && !groupedWinner; index++) {
      const seed = `group-headless-${index}`;
      const winnerMarbleIds = await runHeadlessRace({
        seed,
        stage,
        participants: [
          { name: 'A', weight: 1, count: 1 },
          { name: 'B+C', weight: 1, count: 1 },
          { name: 'D', weight: 1, count: 1 },
        ],
        totalCount: 3,
        spawnPositions: [
          { x: 10.25, y: 1 },
          { x: 10.85, y: 1 },
          { x: 11.45, y: 1 },
        ],
        skillsEnabled: false,
        targetRank: 0,
      });
      const mapping = mapMarbleIdsToParticipants(seed, entries);
      const winnerEntryId = mapping.get(winnerMarbleIds[0]);
      if (winnerEntryId === 'entry-bc') groupedWinner = true;
    }
    assert.equal(groupedWinner, true);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});

function searchTestStage() {
  return {
    title: 'fairness search test',
    finish: { y: 20 },
    camera: { zoomTriggerY: 10 },
    spawn: { origin: { x: 10.25, y: 1 }, maxColumns: 10, columnSpacing: 0.6, rowSpacing: 1, maxUnshiftedRows: 5 },
    entities: [],
  };
}

function createMemoryPhysics(onStep = () => {}) {
  const positions = new Map();
  let clearMarblesCalls = 0;
  let createMarbleCalls = 0;
  let stepCalls = 0;
  let disposeCalls = 0;
  return {
    init: async () => {},
    loadStage() {},
    clearEntities() {},
    resetWorld() {},
    clearMarbles() {
      clearMarblesCalls++;
      positions.clear();
    },
    createMarble(id, x, y) {
      createMarbleCalls++;
      positions.set(id, { x, y, angle: 0 });
    },
    getMarblePosition(id) {
      return positions.get(id);
    },
    shakeMarble() {},
    removeMarble(id) {
      positions.delete(id);
    },
    impact() {},
    start() {},
    step(deltaSeconds) {
      stepCalls++;
      onStep(positions, deltaSeconds);
    },
    getEntityRenderStates() {
      return [];
    },
    dispose() {
      disposeCalls++;
    },
    counters() {
      return { clearMarblesCalls, createMarbleCalls, stepCalls, disposeCalls };
    },
  };
}

test('random mode preserves the completed seed and reserves one distinct next-round seed', async () => {
  const stage = searchTestStage();
  const physics = createMemoryPhysics((positions) => {
    positions.forEach((position) => {
      position.y = 100;
    });
  });
  const session = new RoundSession(new RaceSimulation(physics));
  await session.init();
  session.loadStage(stage);
  session.markReady();
  session.setParticipants(['A']);

  const previewSeed = session.getNextRoundSeed();
  assert.equal(session.getSeed(), previewSeed);
  const generation = session.prepareStart();
  assert.notEqual(generation, null);
  assert.equal(session.getSeed(), previewSeed);
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

  const completedSeed = session.getSeed();
  assert.equal(completedSeed, previewSeed);
  const nextRoundSeed = session.getNextRoundSeed();
  assert.notEqual(nextRoundSeed, completedSeed);
  assert.equal(session.getNextRoundSeed(), nextRoundSeed);

  session.setSeed('explicit-next-seed');
  assert.equal(session.getSeedMode(), 'explicit');
  assert.equal(session.getNextRoundSeed(), 'explicit-next-seed');
});

test('marble preview consumes the same initialization random stream as authoritative marbles', async () => {
  await withNodeBox2d(async () => {
    const stage = searchTestStage();
    const participants = [
      { name: 'A', weight: 0.1, count: 2 },
      { name: 'B', weight: 1, count: 1 },
    ];
    const seed = 'preview-rng-equivalence';
    const spawnPositions = getMarbleSpawnLayout(3, stage.spawn).positions;
    const preview = createMarblePreviewStates(participants, 3, spawnPositions, seed);
    const simulation = new RaceSimulation(undefined, seed);
    try {
      await simulation.init();
      simulation.loadStage(stage);
      simulation.replaceMarbles(participants, 3, spawnPositions, seed);

      const actual = simulation.getRenderStates(0).marbles;
      assert.deepEqual(
        actual.map(({ position, ...state }) => state),
        preview.map(({ position, ...state }) => state)
      );
      actual.forEach(({ position }, index) => {
        assert.ok(Math.abs(position.x - preview[index].position.x) < 0.00001);
        assert.ok(Math.abs(position.y - preview[index].position.y) < 0.00001);
        assert.equal(position.angle, preview[index].position.angle);
      });
    } finally {
      simulation.dispose();
    }
  });
});

test('chunked authoritative marble preparation is equivalent to one-shot preparation', async () => {
  const stage = searchTestStage();
  const participants = [
    { name: 'A', weight: 0.25, count: 3 },
    { name: 'B', weight: 1, count: 2 },
  ];
  const seed = 'chunked-preparation-equivalence';
  const spawnPositions = getMarbleSpawnLayout(5, stage.spawn).positions;
  const oneShot = new RaceSimulation(createMemoryPhysics(), seed);
  const chunked = new RaceSimulation(createMemoryPhysics(), seed);
  oneShot.loadStage(stage);
  chunked.loadStage(stage);
  oneShot.replaceMarbles(participants, 5, spawnPositions, seed);
  const complete = await chunked.replaceMarblesChunked(participants, 5, spawnPositions, seed, true, 2);

  assert.equal(complete, true);
  assert.deepEqual(chunked.getRenderStates(0), oneShot.getRenderStates(0));
});

test('finish result is available before deferred marble cleanup and finished sessions do not keep stepping', async () => {
  const stage = searchTestStage();
  const physics = createMemoryPhysics((positions) => {
    positions.forEach((position) => {
      position.y = 100;
    });
  });
  const session = new RoundSession(new RaceSimulation(physics, 'finish-cleanup-seed'));
  await session.init();
  session.loadStage(stage);
  session.markReady();
  session.setParticipants(['A']);
  const generation = session.prepareStart();
  assert.notEqual(generation, null);
  assert.equal(session.activate(generation), true);
  let finish = null;
  session.advance(80, 1, 1, {
    onImpact() {},
    onFinish() {},
    afterStep() {
      finish = session.checkFinish();
      return 1;
    },
    onStepComplete() {},
  });
  const clearCallsBeforeFinish = physics.counters().clearMarblesCalls;
  assert.ok(finish);
  assert.equal(physics.counters().clearMarblesCalls, clearCallsBeforeFinish);
  assert.deepEqual(session.getResult(), finish.result);

  const stepsAfterFinish = physics.counters().stepCalls;
  session.advance(80, 1, 1, {
    onImpact() {},
    onFinish() {},
    afterStep() {
      return 1;
    },
    onStepComplete() {},
  });
  assert.equal(physics.counters().stepCalls, stepsAfterFinish);

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(physics.counters().clearMarblesCalls, clearCallsBeforeFinish + 1);
});

function searchTestRequest(stage, participantInputs, currentSeed = 'current') {
  return {
    stage,
    mapIndex: 0,
    participantInputs,
    winnerRange: { start: 0, end: 0 },
    skillsEnabled: false,
    currentSeed,
  };
}

function marbleForEntry(seed, entryIds) {
  const mapping = mapMarbleIdsToParticipants(
    seed,
    entryIds.map((participantId) => ({ participantId, count: 1 }))
  );
  return Array.from(mapping.entries()).find(([, participantId]) => participantId === entryIds[entryIds.length - 1])[0];
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function createReadyControlledWorkerPool() {
  let readyConcurrency = 1;
  const readinessWaiters = new Set();
  const attemptGates = new Map();
  const attemptStarted = new Map();
  const attemptCancelled = new Map();
  const calls = [];
  const completionOrder = [];

  const getGate = (gates, seed) => {
    let gate = gates.get(seed);
    if (!gate) {
      gate = deferred();
      gates.set(seed, gate);
    }
    return gate;
  };

  const settleReadinessWaiter = (waiter, error = null) => {
    if (!readinessWaiters.delete(waiter)) return;
    waiter.removeAbortListener?.();
    waiter.removeAbortListener = null;
    if (error) waiter.gate.reject(error);
    else waiter.gate.resolve();
  };

  const pool = {
    concurrency: 3,
    get readyConcurrency() {
      return readyConcurrency;
    },
    get waiterCount() {
      return readinessWaiters.size;
    },
    get waiterMinimums() {
      return [...readinessWaiters].map(({ minimum }) => minimum);
    },
    calls,
    completionOrder,
    waitForReadyConcurrency(minimum, signal) {
      if (signal?.aborted) return Promise.reject(new HeadlessSimulationCancelledError());
      if (readyConcurrency >= minimum) return Promise.resolve();

      const waiter = {
        minimum,
        gate: deferred(),
        removeAbortListener: null,
      };
      readinessWaiters.add(waiter);
      if (signal) {
        const onAbort = () => settleReadinessWaiter(waiter, new HeadlessSimulationCancelledError());
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.removeAbortListener = () => signal.removeEventListener('abort', onAbort);
        if (signal.aborted) onAbort();
      }
      if (readyConcurrency >= minimum) settleReadinessWaiter(waiter);
      return waiter.gate.promise;
    },
    setReadyConcurrency(nextReadyConcurrency) {
      readyConcurrency = nextReadyConcurrency;
      [...readinessWaiters].forEach((waiter) => {
        if (readyConcurrency >= waiter.minimum) settleReadinessWaiter(waiter);
      });
    },
    waitForAttempt(seed) {
      return getGate(attemptStarted, seed).promise;
    },
    waitForCancellation(seed) {
      return getGate(attemptCancelled, seed).promise;
    },
    resolveAttempt(seed, winnerMarbleIds) {
      const gate = attemptGates.get(seed);
      if (!gate) throw new Error(`Attempt ${seed} has not started`);
      completionOrder.push(seed);
      gate.resolve(winnerMarbleIds);
    },
    run(request, options) {
      const { seed } = request;
      const gate = deferred();
      attemptGates.set(seed, gate);
      calls.push({ request, options });
      getGate(attemptStarted, seed).resolve();

      let settled = false;
      const cancelled = getGate(attemptCancelled, seed);
      const onAbort = () => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener('abort', onAbort);
        cancelled.resolve();
        gate.reject(new HeadlessSimulationCancelledError());
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) onAbort();

      return gate.promise.then(
        (result) => {
          settled = true;
          options.signal?.removeEventListener('abort', onAbort);
          return result;
        },
        (error) => {
          settled = true;
          options.signal?.removeEventListener('abort', onAbort);
          throw error;
        }
      );
    },
  };
  return pool;
}

async function createUnbalancedSearchCoordinator(headlessRunner, createCandidateSeed, workerPool) {
  let id = 0;
  const store = new InMemoryFairnessStore();
  const coordinator = new FairnessCoordinator({
    store,
    createId: (prefix) => `${prefix}-${++id}`,
    now: () => id,
    createCandidateSeed,
    headlessRunner,
    workerPool,
  });
  coordinator.setCurrentParticipantInputs(['A', 'B']);
  await coordinator.setEnabled(true);
  const stage = searchTestStage();
  const base = await coordinator.prepareUnconstrainedDraw(searchTestRequest(stage, ['A', 'B'], 'base'));
  const winner = base.event.entries.find(({ displayName }) => displayName === 'A').marbleIds;
  assert.equal((await coordinator.confirmDraw(base.drawId, winner, null)).confirmed, true);
  return { coordinator, stage, store };
}

test('fairness precompute reuses one ready candidate without creating draw events', async () => {
  let calls = 0;
  const { coordinator, stage } = await createUnbalancedSearchCoordinator(
    async ({ seed }) => {
      calls++;
      return [marbleForEntry(seed, ['entry-0', 'entry-1'])];
    },
    () => 'precomputed-seed'
  );
  const request = searchTestRequest(stage, ['A', 'B'], 'unused-current-seed');
  const before = await coordinator.getState();

  await coordinator.precompute(request);
  assert.equal(calls, 1);
  assert.equal((await coordinator.getState()).recentDraws.length, before.recentDraws.length);
  await coordinator.precompute({ ...request, currentSeed: 'another-current-seed' });
  assert.equal(calls, 1);

  const prepared = await coordinator.prepareDraw(request, coordinator.beginStart());
  assert.equal(calls, 1);
  assert.equal(prepared.seed, 'precomputed-seed');
});

test('fairness start joins an in-flight precompute instead of starting a second search', async () => {
  let calls = 0;
  let runnerSignal;
  let resolveRunner;
  let signalRunnerStarted;
  const runnerStarted = new Promise((resolve) => {
    signalRunnerStarted = resolve;
  });
  const { coordinator, stage } = await createUnbalancedSearchCoordinator(
    ({ seed }, options) => {
      calls++;
      runnerSignal = options.signal;
      return new Promise((resolve) => {
        resolveRunner = () => resolve([marbleForEntry(seed, ['entry-0', 'entry-1'])]);
        signalRunnerStarted();
      });
    },
    () => 'in-flight-seed'
  );
  const request = searchTestRequest(stage, ['A', 'B']);
  const precompute = coordinator.precompute(request);
  await runnerStarted;
  const start = coordinator.prepareDraw(request, coordinator.beginStart());
  resolveRunner();

  const prepared = await start;
  await precompute;
  assert.equal(calls, 1);
  assert.equal(runnerSignal.aborted, false);
  assert.equal(prepared.seed, 'in-flight-seed');
});

test('stale fairness precompute cannot overwrite a newer generation candidate', async () => {
  let calls = 0;
  let oldSignal;
  let resolveOldRunner;
  let signalOldRunnerStarted;
  const oldRunnerStarted = new Promise((resolve) => {
    signalOldRunnerStarted = resolve;
  });
  const { coordinator, stage } = await createUnbalancedSearchCoordinator(
    ({ seed }, options) => {
      calls++;
      if (calls === 1) {
        oldSignal = options.signal;
        return new Promise((resolve) => {
          resolveOldRunner = () => resolve([marbleForEntry(seed, ['entry-0', 'entry-1'])]);
          signalOldRunnerStarted();
        });
      }
      return Promise.resolve([marbleForEntry(seed, ['entry-0', 'entry-1', 'entry-2'])]);
    },
    (() => {
      const seeds = ['old-seed', 'new-seed'];
      return () => seeds.shift();
    })()
  );
  const oldRequest = searchTestRequest(stage, ['A', 'B']);
  const oldPrecompute = coordinator.precompute(oldRequest).catch((error) => error);
  await oldRunnerStarted;

  coordinator.setCurrentParticipantInputs(['A', 'B', 'C']);
  assert.equal(oldSignal.aborted, true);
  await coordinator.getState();
  const newRequest = searchTestRequest(stage, ['A', 'B', 'C']);
  await coordinator.precompute(newRequest);
  resolveOldRunner();
  const staleResult = await oldPrecompute;

  assert.equal(staleResult instanceof Error, true);
  assert.equal(calls, 2);
  const prepared = await coordinator.prepareDraw(newRequest, coordinator.beginStart());
  assert.equal(prepared.seed, 'new-seed');
  assert.equal(calls, 2);
  const state = await coordinator.getState();
  assert.equal(state.available, true);
  assert.equal(state.error, null);
  assert.equal(state.recentDraws.filter(({ status }) => status === 'failed').length, 0);
});

test('stale worker generation aborts every active worker attempt', async () => {
  const signals = [];
  let startedResolve;
  const started = new Promise((resolve) => {
    startedResolve = resolve;
  });
  const workerPool = {
    concurrency: 3,
    run(_request, options) {
      signals.push(options.signal);
      if (signals.length === 3) startedResolve();
      return new Promise((_resolve, reject) => {
        const onAbort = () => {
          options.signal.removeEventListener('abort', onAbort);
          reject(new HeadlessSimulationCancelledError());
        };
        options.signal.addEventListener('abort', onAbort, { once: true });
        if (options.signal.aborted) onAbort();
      });
    },
  };
  const { coordinator, stage } = await createUnbalancedSearchCoordinator(
    undefined,
    () => 'stale-worker-seed',
    workerPool
  );
  const pending = coordinator.precompute(searchTestRequest(stage, ['A', 'B'])).catch((error) => error);
  await started;

  coordinator.setCurrentParticipantInputs(['A', 'B', 'C']);
  const result = await pending;
  assert.equal(result instanceof Error, true);
  assert.equal(
    signals.every((signal) => signal.aborted),
    true
  );
  const state = await coordinator.getState();
  assert.equal(state.error, null);
  assert.equal(
    state.recentDraws.some(({ status }) => status === 'failed'),
    false
  );
});

test('confirmed draw invalidation aborts a running fairness search', async () => {
  let signal;
  let resolveRunner;
  let signalRunnerStarted;
  const runnerStarted = new Promise((resolve) => {
    signalRunnerStarted = resolve;
  });
  const { coordinator, stage } = await createUnbalancedSearchCoordinator(
    ({ seed }, options) => {
      signal = options.signal;
      return new Promise((resolve) => {
        resolveRunner = () => resolve([marbleForEntry(seed, ['entry-0', 'entry-1'])]);
        signalRunnerStarted();
      });
    },
    () => 'confirmed-invalidation-seed'
  );
  const request = searchTestRequest(stage, ['A', 'B']);
  const pending = coordinator.precompute(request).catch((error) => error);
  await runnerStarted;

  const ordinary = await coordinator.prepareUnconstrainedDraw(searchTestRequest(stage, ['A', 'B'], 'ordinary'));
  const aWinner = ordinary.event.entries.find(({ displayName }) => displayName === 'A').marbleIds;
  await coordinator.confirmDraw(ordinary.drawId, aWinner, null);

  assert.equal(signal.aborted, true);
  resolveRunner();
  assert.equal((await pending) instanceof Error, true);
});

test('strict-balance fast path skips speculative headless search', async () => {
  let calls = 0;
  const coordinator = new FairnessCoordinator({
    store: new InMemoryFairnessStore(),
    headlessRunner: async () => {
      calls++;
      return [0];
    },
    createCandidateSeed: () => 'unused-seed',
  });
  coordinator.setCurrentParticipantInputs(['A', 'B']);
  await coordinator.setEnabled(true);
  const stage = searchTestStage();

  await coordinator.precompute(searchTestRequest(stage, ['A', 'B']));
  assert.equal(calls, 0);
  assert.equal((await coordinator.getState()).recentDraws.length, 0);
});

test('strict-balance fast path uses the reserved next-round seed without changing the completed seed', async () => {
  let calls = 0;
  const coordinator = new FairnessCoordinator({
    store: new InMemoryFairnessStore(),
    headlessRunner: async () => {
      calls++;
      return [0];
    },
  });
  coordinator.setCurrentParticipantInputs(['A', 'B']);
  await coordinator.setEnabled(true);
  const request = {
    ...searchTestRequest(searchTestStage(), ['A', 'B'], 'completed-round-seed'),
    nextRoundSeed: 'reserved-next-round-seed',
  };

  const plan = await coordinator.precompute(request);
  assert.equal(plan.seed, 'reserved-next-round-seed');
  const prepared = await coordinator.prepareDraw(request, coordinator.beginStart());

  assert.equal(prepared.seed, 'reserved-next-round-seed');
  assert.equal(prepared.event.seed, 'reserved-next-round-seed');
  assert.equal(calls, 0);
  assert.equal((await coordinator.getState()).recentDraws[0].status, 'prepared');
});

test('strict precompute caches its prepared draft and rebuilds it for a new seed', async () => {
  let draftCalls = 0;
  const originalCreatePreparedDrawDraft = FairnessCoordinator.prototype.createPreparedDrawDraft;
  FairnessCoordinator.prototype.createPreparedDrawDraft = function (...args) {
    draftCalls++;
    return originalCreatePreparedDrawDraft.apply(this, args);
  };

  try {
    const coordinator = new FairnessCoordinator({ store: new InMemoryFairnessStore() });
    coordinator.setCurrentParticipantInputs(['A', 'B']);
    await coordinator.setEnabled(true);
    const stage = searchTestStage();
    const request = searchTestRequest(stage, ['A', 'B'], 'first-seed');

    await coordinator.precompute(request);
    assert.equal(draftCalls, 1);
    assert.equal((await coordinator.getState()).recentDraws.length, 0);

    const prepared = await coordinator.prepareDraw(request, coordinator.beginStart());
    assert.equal(draftCalls, 1);
    assert.equal(prepared.event.seed, 'first-seed');

    const rebuilt = await coordinator.prepareDraw({ ...request, currentSeed: 'second-seed' }, coordinator.beginStart());
    assert.equal(draftCalls, 2);
    assert.equal(rebuilt.event.seed, 'second-seed');

    coordinator.invalidatePrecompute();
    const afterInvalidation = await coordinator.prepareDraw(request, coordinator.beginStart());
    assert.equal(draftCalls, 3);
    assert.equal(afterInvalidation.event.seed, 'first-seed');
  } finally {
    FairnessCoordinator.prototype.createPreparedDrawDraft = originalCreatePreparedDrawDraft;
  }
});

test('confirmed fairness balance changes invalidate a ready candidate', async () => {
  let calls = 0;
  const seeds = ['first-candidate', 'second-candidate'];
  const { coordinator, stage } = await createUnbalancedSearchCoordinator(
    async ({ seed }) => {
      calls++;
      return [marbleForEntry(seed, ['entry-0', 'entry-1'])];
    },
    () => seeds.shift()
  );
  const request = searchTestRequest(stage, ['A', 'B']);
  await coordinator.precompute(request);
  assert.equal(calls, 1);

  const ordinary = await coordinator.prepareUnconstrainedDraw(searchTestRequest(stage, ['A', 'B'], 'ordinary'));
  const aWinner = ordinary.event.entries.find(({ displayName }) => displayName === 'A').marbleIds;
  assert.equal((await coordinator.confirmDraw(ordinary.drawId, aWinner, null)).confirmed, true);

  const prepared = await coordinator.prepareDraw(request, coordinator.beginStart());
  assert.equal(calls, 2);
  assert.equal(prepared.seed, 'second-candidate');
});

test('start bypasses a pending fairness precompute debounce', async () => {
  let calls = 0;
  const { coordinator, stage } = await createUnbalancedSearchCoordinator(
    async ({ seed }) => {
      calls++;
      return [marbleForEntry(seed, ['entry-0', 'entry-1'])];
    },
    () => 'immediate-start-seed'
  );
  const request = searchTestRequest(stage, ['A', 'B']);

  coordinator.schedulePrecompute(request, 1000);
  const prepared = await coordinator.prepareDraw(request, coordinator.beginStart());

  assert.equal(calls, 1);
  assert.equal(prepared.seed, 'immediate-start-seed');
});

test('non-cancellation headless errors retain search retry semantics', async () => {
  let calls = 0;
  const { coordinator, stage } = await createUnbalancedSearchCoordinator(
    async ({ seed }) => {
      calls++;
      if (calls === 1) throw new Error('transient simulation failure');
      return [marbleForEntry(seed, ['entry-0', 'entry-1'])];
    },
    (() => {
      const seeds = ['failed-seed', 'retry-seed'];
      return () => seeds.shift();
    })()
  );

  const prepared = await coordinator.prepareDraw(searchTestRequest(stage, ['A', 'B']), coordinator.beginStart());
  assert.equal(calls, 2);
  assert.equal(prepared.seed, 'retry-seed');
});

test('rapid exclusion requests resolve to the last requested state', async () => {
  const { coordinator, store } = await createUnbalancedSearchCoordinator(
    async ({ seed }) => [marbleForEntry(seed, ['entry-0', 'entry-1'])],
    () => 'unused-exclusion-seed'
  );
  const participant = (await coordinator.getState()).participants.find(({ displayName }) => displayName === 'A');
  const request = (excluded) => coordinator.setParticipantExcluded(participant.id, excluded);

  const originalEnsureOperational = FairnessCoordinator.prototype.ensureOperational;
  let ensureOperationalCalls = 0;
  FairnessCoordinator.prototype.ensureOperational = async function () {
    const delay = ensureOperationalCalls++ === 0 ? 30 : 0;
    await new Promise((resolve) => setTimeout(resolve, delay));
    return originalEnsureOperational.call(this);
  };
  try {
    await Promise.all([request(true), request(false)]);
  } finally {
    FairnessCoordinator.prototype.ensureOperational = originalEnsureOperational;
  }
  assert.equal((await coordinator.getState()).participants.find(({ id }) => id === participant.id).excluded, false);
  const firstReplay = new FairnessCoordinator({ store });
  assert.equal((await firstReplay.getState()).participants.find(({ id }) => id === participant.id).excluded, false);

  await Promise.all([request(false), request(true), request(false), request(true)]);
  assert.equal((await coordinator.getState()).participants.find(({ id }) => id === participant.id).excluded, true);
  const exclusionEvents = (await coordinator.exportData()).events.filter(
    ({ type }) => type === 'participantExclusionChanged'
  );
  assert.deepEqual(
    exclusionEvents.map(({ excluded }) => excluded),
    [true, false, true, false, true]
  );
  const finalReplay = new FairnessCoordinator({ store });
  assert.equal((await finalReplay.getState()).participants.find(({ id }) => id === participant.id).excluded, true);
});

test('rapid participant renames persist the final requested name', async () => {
  const { coordinator, store } = await createUnbalancedSearchCoordinator(
    async ({ seed }) => [marbleForEntry(seed, ['entry-0', 'entry-1'])],
    () => 'unused-rename-seed'
  );
  const participant = (await coordinator.getState()).participants.find(({ displayName }) => displayName === 'A');

  const originalEnsureOperational = FairnessCoordinator.prototype.ensureOperational;
  let ensureOperationalCalls = 0;
  FairnessCoordinator.prototype.ensureOperational = async function () {
    const delay = ensureOperationalCalls++ === 0 ? 30 : 0;
    await new Promise((resolve) => setTimeout(resolve, delay));
    return originalEnsureOperational.call(this);
  };
  try {
    await Promise.all([
      coordinator.renameParticipant(participant.id, 'A'),
      coordinator.renameParticipant(participant.id, 'B'),
      coordinator.renameParticipant(participant.id, 'C'),
    ]);
  } finally {
    FairnessCoordinator.prototype.ensureOperational = originalEnsureOperational;
  }

  const state = await coordinator.getState();
  assert.equal(state.participants.find(({ id }) => id === participant.id).displayName, 'C');
  const exported = await coordinator.exportData();
  assert.equal(
    projectFairnessEvents(exported.events).participants.find(({ id }) => id === participant.id).displayName,
    'C'
  );
  const renameEvents = exported.events.filter(({ type }) => type === 'participantRenamed');
  assert.deepEqual(
    renameEvents.map(({ displayName }) => displayName),
    ['B', 'C']
  );
  const replay = new FairnessCoordinator({ store });
  assert.equal((await replay.getState()).participants.find(({ id }) => id === participant.id).displayName, 'C');
});

test('worker search keeps serial candidate ordering and cancels higher attempts', async () => {
  let id = 0;
  const seeds = ['attempt-0', 'attempt-1', 'attempt-2', 'attempt-3'];
  const calls = [];
  let cancelled = 0;
  const workerPool = {
    concurrency: 3,
    run(request, options) {
      calls.push({ request, options });
      const delay = request.seed === 'attempt-0' ? 0 : request.seed === 'attempt-1' ? 20 : 100;
      const winnerEntry = request.seed === 'attempt-0' ? 'entry-0' : 'entry-1';
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          settled = true;
          options.signal?.removeEventListener('abort', onAbort);
          resolve([marbleForEntry(request.seed, ['entry-0', winnerEntry])]);
        }, delay);
        const onAbort = () => {
          if (settled) return;
          settled = true;
          cancelled++;
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
          reject(new HeadlessSimulationCancelledError());
        };
        options.signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
  const coordinator = new FairnessCoordinator({
    store: new InMemoryFairnessStore(),
    workerPool,
    createId: (prefix) => `${prefix}-${++id}`,
    now: () => id,
    createCandidateSeed: () => seeds.shift(),
  });
  coordinator.setCurrentParticipantInputs(['A', 'B']);
  await coordinator.setEnabled(true);
  const stage = searchTestStage();
  const base = await coordinator.prepareUnconstrainedDraw(searchTestRequest(stage, ['A', 'B'], 'base'));
  const aWinner = base.event.entries.find(({ displayName }) => displayName === 'A').marbleIds;
  await coordinator.confirmDraw(base.drawId, aWinner, null);

  const prepared = await coordinator.prepareDraw(searchTestRequest(stage, ['A', 'B']), coordinator.beginStart());
  assert.equal(prepared.seed, 'attempt-1');
  assert.equal(calls.length, 4);
  assert.equal(
    calls.every(({ options }) => options.stepLimit > 0),
    true
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(cancelled >= 1);
});

test('parallel fairness search keeps the speculative window bounded', async () => {
  const seeds = ['bounded-0', 'bounded-1', 'bounded-2', 'bounded-3', 'bounded-4', 'bounded-5'];
  const calls = [];
  let resolveFirst;
  let firstStartedResolve;
  const firstStarted = new Promise((resolve) => {
    firstStartedResolve = resolve;
  });
  const winnerForEntry = (seed, entryId) => {
    const mapping = mapMarbleIdsToParticipants(seed, [
      { participantId: 'entry-0', count: 1 },
      { participantId: 'entry-1', count: 1 },
    ]);
    return [Array.from(mapping.entries()).find(([, participantId]) => participantId === entryId)[0]];
  };
  const workerPool = {
    concurrency: 3,
    run(request) {
      calls.push(request.seed);
      if (request.seed === 'bounded-0') {
        firstStartedResolve();
        return new Promise((resolve) => {
          resolveFirst = () => resolve(winnerForEntry(request.seed, 'entry-0'));
        });
      }
      const entryId = request.seed === 'bounded-3' ? 'entry-1' : 'entry-0';
      return Promise.resolve(winnerForEntry(request.seed, entryId));
    },
  };
  const coordinator = new FairnessCoordinator({
    store: new InMemoryFairnessStore(),
    workerPool,
    createCandidateSeed: () => seeds.shift(),
  });
  coordinator.setCurrentParticipantInputs(['A', 'B']);
  await coordinator.setEnabled(true);
  const stage = searchTestStage();
  const base = await coordinator.prepareUnconstrainedDraw(searchTestRequest(stage, ['A', 'B'], 'base'));
  const aWinner = base.event.entries.find(({ displayName }) => displayName === 'A').marbleIds;
  assert.equal((await coordinator.confirmDraw(base.drawId, aWinner, null)).confirmed, true);

  const pending = coordinator.prepareDraw(searchTestRequest(stage, ['A', 'B']), coordinator.beginStart());
  await firstStarted;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ['bounded-0', 'bounded-1', 'bounded-2']);

  resolveFirst();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const prepared = await pending;
  assert.equal(prepared.seed, 'bounded-3');
  assert.equal(calls.length, 6);
  assert.deepEqual(calls.slice(0, 3), ['bounded-0', 'bounded-1', 'bounded-2']);
  assert.deepEqual(calls.slice(3), ['bounded-3', 'bounded-4', 'bounded-5']);
});

test('parallel fairness search grows only with ready workers and commits lower attempts first', async () => {
  const seeds = ['ready-0', 'ready-1', 'ready-2'];
  const workerPool = createReadyControlledWorkerPool();
  const { coordinator, stage } = await createUnbalancedSearchCoordinator(undefined, () => seeds.shift(), workerPool);
  const pending = coordinator.prepareDraw(searchTestRequest(stage, ['A', 'B']), coordinator.beginStart());
  const assertWindow = (nextCommit) => {
    const nextAttempt = workerPool.calls.length;
    assert.ok(nextAttempt - nextCommit <= workerPool.readyConcurrency);
  };

  await workerPool.waitForAttempt('ready-0');
  assert.equal(workerPool.readyConcurrency, 1);
  assert.deepEqual(
    workerPool.calls.map(({ request }, index) => ({ index, seed: request.seed })),
    [{ index: 0, seed: 'ready-0' }]
  );
  assert.equal(workerPool.waiterCount, 1);
  assert.deepEqual(workerPool.waiterMinimums, [2]);
  // No result has committed at this gate, so nextCommit is still zero.
  assertWindow(0);

  workerPool.setReadyConcurrency(2);
  await workerPool.waitForAttempt('ready-1');
  assert.equal(workerPool.readyConcurrency, 2);
  assert.deepEqual(
    workerPool.calls.map(({ request }, index) => ({ index, seed: request.seed })),
    [
      { index: 0, seed: 'ready-0' },
      { index: 1, seed: 'ready-1' },
    ]
  );
  assert.equal(workerPool.waiterCount, 1);
  assert.deepEqual(workerPool.waiterMinimums, [3]);
  assertWindow(0);

  workerPool.setReadyConcurrency(3);
  await workerPool.waitForAttempt('ready-2');
  assert.equal(workerPool.readyConcurrency, 3);
  assert.deepEqual(
    workerPool.calls.map(({ request }, index) => ({ index, seed: request.seed })),
    [
      { index: 0, seed: 'ready-0' },
      { index: 1, seed: 'ready-1' },
      { index: 2, seed: 'ready-2' },
    ]
  );
  assert.equal(workerPool.waiterCount, 0);
  assert.deepEqual(workerPool.waiterMinimums, []);
  assertWindow(0);

  // Attempt 1 is eligible and completes before the lower-index attempt 0.
  // Attempt 2 is also eligible in principle, but must be cancelled once 1
  // becomes the serial-equivalent winner after attempt 0 is committed.
  workerPool.resolveAttempt('ready-1', [marbleForEntry('ready-1', ['entry-0', 'entry-1'])]);
  workerPool.resolveAttempt('ready-0', [marbleForEntry('ready-0', ['entry-0'])]);

  const prepared = await pending;
  assert.equal(prepared.seed, 'ready-1');
  await workerPool.waitForCancellation('ready-2');
  assertWindow(2);
  assert.deepEqual(workerPool.completionOrder, ['ready-1', 'ready-0']);
  assert.deepEqual(
    workerPool.calls.map(({ request }) => request.seed),
    ['ready-0', 'ready-1', 'ready-2']
  );
  assert.equal(workerPool.calls[2].options.signal.aborted, true);
});

test('parallel fairness search aborts a pending readiness wait as cancellation', async () => {
  const workerPool = createReadyControlledWorkerPool();
  const { coordinator, stage } = await createUnbalancedSearchCoordinator(undefined, () => 'ready-abort-0', workerPool);
  const pending = coordinator
    .prepareDraw(searchTestRequest(stage, ['A', 'B']), coordinator.beginStart())
    .catch((error) => error);

  await workerPool.waitForAttempt('ready-abort-0');
  assert.equal(workerPool.waiterCount, 1);
  assert.deepEqual(workerPool.waiterMinimums, [2]);
  assert.deepEqual(
    workerPool.calls.map(({ request }) => request.seed),
    ['ready-abort-0']
  );

  coordinator.invalidateStart();
  const error = await pending;
  await workerPool.waitForCancellation('ready-abort-0');

  assert.ok(error instanceof Error);
  assert.match(error.message, /cancel/i);
  assert.equal(error instanceof WorkerPoolUnavailableError, false);
  assert.notEqual(error.name, 'WorkerPoolUnavailableError');
  assert.equal(workerPool.waiterCount, 0);
  assert.deepEqual(workerPool.waiterMinimums, []);
});

test('worker infrastructure failure falls back to one serial main-thread search', async () => {
  const seeds = ['fallback-0', 'fallback-1', 'fallback-2'];
  const workerCalls = [];
  const fallbackCalls = [];
  let activeFallbacks = 0;
  let maxActiveFallbacks = 0;
  const winnerForEntry = (seed, entryId) => {
    const mapping = mapMarbleIdsToParticipants(seed, [
      { participantId: 'entry-0', count: 1 },
      { participantId: 'entry-1', count: 1 },
    ]);
    return [Array.from(mapping.entries()).find(([, participantId]) => participantId === entryId)[0]];
  };
  const workerPool = {
    concurrency: 3,
    run(request) {
      workerCalls.push(request.seed);
      return Promise.reject(new WorkerPoolUnavailableError('worker runtime failed'));
    },
  };
  const { coordinator, stage } = await createUnbalancedSearchCoordinator(
    async ({ seed }) => {
      fallbackCalls.push(seed);
      activeFallbacks++;
      maxActiveFallbacks = Math.max(maxActiveFallbacks, activeFallbacks);
      await Promise.resolve();
      activeFallbacks--;
      return winnerForEntry(seed, seed === 'fallback-2' ? 'entry-1' : 'entry-0');
    },
    () => seeds.shift(),
    workerPool
  );
  const request = searchTestRequest(stage, ['A', 'B']);

  const prepared = await coordinator.prepareDraw(request, coordinator.beginStart());
  assert.equal(prepared.seed, 'fallback-2');
  assert.deepEqual(workerCalls, ['fallback-0', 'fallback-1', 'fallback-2']);
  assert.deepEqual(fallbackCalls, ['fallback-0', 'fallback-1', 'fallback-2']);
  assert.equal(maxActiveFallbacks, 1);
});

test('worker failure keeps a completed lower-order result and the failed seed for serial fallback', async () => {
  const workerCalls = [];
  const fallbackCalls = [];
  let seedIndex = 0;
  const winnerForEntry = (seed, entryId) => {
    const mapping = mapMarbleIdsToParticipants(seed, [
      { participantId: 'entry-0', count: 1 },
      { participantId: 'entry-1', count: 1 },
    ]);
    return [Array.from(mapping.entries()).find(([, participantId]) => participantId === entryId)[0]];
  };
  const workerPool = {
    concurrency: 3,
    run(request, options) {
      workerCalls.push(request.seed);
      if (request.seed === 'infra-1') {
        return new Promise((_resolve, reject) => {
          const timer = setTimeout(() => reject(new WorkerPoolUnavailableError('worker runtime failed')), 5);
          options.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new HeadlessSimulationCancelledError());
            },
            { once: true }
          );
        });
      }
      return Promise.resolve(winnerForEntry(request.seed, 'entry-0'));
    },
  };
  const { coordinator, stage } = await createUnbalancedSearchCoordinator(
    async ({ seed }) => {
      fallbackCalls.push(seed);
      return winnerForEntry(seed, seed === 'infra-1' ? 'entry-1' : 'entry-0');
    },
    () => `infra-${seedIndex++}`,
    workerPool
  );

  const prepared = await coordinator.prepareDraw(searchTestRequest(stage, ['A', 'B']), coordinator.beginStart());
  assert.equal(prepared.seed, 'infra-1');
  assert.deepEqual(fallbackCalls, ['infra-1']);
  assert.deepEqual(workerCalls.slice(0, 3), ['infra-0', 'infra-1', 'infra-2']);
});
