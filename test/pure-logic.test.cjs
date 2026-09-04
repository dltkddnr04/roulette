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

const { parseName, shuffle } = loadTypeScriptModule('src/utils/utils.ts');
const { normalizeParticipantNames } = loadTypeScriptModule('src/utils/participants.ts');
const { getMarbleSpawnLayout } = loadTypeScriptModule('src/utils/marbleSpawn.ts');
const { Marble } = loadTypeScriptModule('src/marble.ts');
const { getStepBudget, preservePhysicsDebt, RaceSimulation } = loadTypeScriptModule('src/raceSimulation.ts');
const { RoundSession } = loadTypeScriptModule('src/roundSession.ts');
const { validateReplayDescriptor } = loadTypeScriptModule('src/replay.ts');
const { createSeededRandom } = loadTypeScriptModule('src/utils/random.ts');

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
  const physics = {
    init: async () => {},
    loadStage() {},
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

  const generation = session.prepareStart();
  assert.equal(session.roundState, 'running');
  assert.ok(generation !== null);
  assert.equal(session.prepareStart(), null);
  assert.equal(session.activate(generation), true);

  session.reset();
  assert.equal(session.roundState, 'ready');
  assert.equal(session.getCount(), 0);

  const rebuilt = session.setMap(replacementStage);
  assert.equal(rebuilt.positions.length, 5);
  assert.equal(session.getCount(), 5);
  assert.equal(session.currentStage, replacementStage);
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
