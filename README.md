# Marble Roulette

A self-hostable marble roulette for visual lucky draws, powered by `box2d-wasm`.

This repository is a fork of [lazygyu/roulette](https://github.com/lazygyu/roulette). It keeps the original game and map foundation while focusing on self-hosting, predictable simulation timing, high-refresh-rate rendering, and operator-controlled customization.

## What changed from upstream

- Removed the upstream commercial advertising service, preroll/result ad overlays, impression tracking, external keyword/sprite service, and analytics integrations.
- Added local Sponsor/Branding controls: upload multiple images, persist them as Blobs in IndexedDB, select one from a dropdown, temporarily disable rendering with an `enabled` toggle, and delete selected images.
- The selected sponsor image is rendered on every `StageDef.branding` position as a world-space billboard, preserving its aspect ratio with contain fitting. It naturally follows the camera, zoom, and DPR and is included in recordings.
- Added Cloudflare Workers Static Assets deployment support.
- Simplified rendering from a permanent two-canvas pipeline to one visible canvas.
- Added DPR-aware render quality modes:
  - **Performance**: `0.5x`
  - **Native**: `1x`
- Added render interpolation for marbles and moving map entities.
- Normalized camera smoothing across display refresh rates.
- Kept Box2D and game logic on a fixed `10 ms` simulation step.
- Slow motion and fast-forward change fixed-step cadence instead of changing the Box2D timestep.
- Preserve unprocessed simulation budget as debt instead of dropping elapsed time after foreground stalls.
- Perform marble ordering on the fixed simulation clock rather than once per render frame.
- Remove finished marble bodies before the next physics step so winners cannot affect later collisions.
- Hardened recording fallback, MIME/container handling, input parsing, asset failures, and rendering edge cases.
- Normalized map rotation values to radians where legacy data used degree-like values.

## Simulation model

The runtime separates three concerns:

1. **Presentation clock** — `requestAnimationFrame`, camera smoothing, and rendering.
2. **Scheduler budget** — controls how frequently fixed simulation steps are executed for normal, slow-motion, and fast-forward playback.
3. **Simulation clock** — Box2D and marble game logic always advance in fixed `10 ms` steps.

Rendering interpolates between simulation snapshots, so a high-refresh-rate display can present smoother motion without changing the physics timestep.

The project still uses `Math.random()` for shuffle and game randomness. Runs are therefore not seeded or bit-for-bit reproducible; the timing work is intended to prevent render-frame grouping and display refresh rate from unnecessarily influencing simulation order.

## Input

Names may include an optional positive integer weight and/or count:

```text
Alice
Alice/2
Alice*3
Alice/2*3
Alice*3/2
```

Malformed modifiers, non-positive values, and trailing junk are rejected. A hard safety ceiling of **1000 marbles** prevents accidental or hostile input from creating unbounded arrays and Box2D bodies.

## Requirements

- Node.js
- Yarn
- TypeScript
- Parcel
- `box2d-wasm`

## Development

```shell
yarn
yarn dev
```

The development server runs on port `1235` by default.

## Build

```shell
yarn build
```

The production build is generated in `dist/` with the public URL rooted at `/`.

Useful validation commands:

```shell
corepack yarn build
git diff --check
npx biome check src/
```

## Cloudflare Workers deployment

The repository includes `wrangler.jsonc` configured to serve `./dist` through Cloudflare Workers Static Assets.

```shell
yarn build
yarn deploy
```

`yarn deploy` runs `wrangler deploy`.

## Sponsor / Branding

Sponsor images are local and operator-controlled. Multiple images can be uploaded and persist as Blobs in IndexedDB; one can be selected from the dropdown, temporarily disabled with the `enabled` toggle, or deleted. When enabled and an image is selected, that image is rendered with contain fitting on every `StageDef.branding` position in world space, so it follows camera movement and zoom and is included in DPR-aware rendering and recordings. If no image is available or selected, nothing is rendered.

This fork has no external advertising API, sponsor fetch, tracking, click links, preroll, or result overlay.

## License

This project remains distributed under the [MIT License](LICENSE). Original project credit belongs to [lazygyu/roulette](https://github.com/lazygyu/roulette).
