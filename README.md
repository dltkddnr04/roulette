# Marble Roulette

A marble-based roulette game for running fair and visual lucky draws.

This repository is a fork of [lazygyu/roulette](https://github.com/lazygyu/roulette). The fork focuses on making the application easier to host and customize for different communities and events.

## Goals

- **Cloudflare Workers hosting compatibility**
  - Keep the application deployable as a static site through Cloudflare Workers and Workers Sites.
  - Make the build and asset paths configurable enough for Cloudflare deployments.
- **User-defined advertising**
  - Allow site owners to configure their own advertising content.
  - Support advertising placements without coupling the application to a single ad provider.

These features are the primary direction of this fork and may be introduced incrementally.

## Features

- Physics-based marble roulette powered by `box2d-wasm`
- TypeScript frontend
- Static build output suitable for modern hosting platforms

## Requirements

- Node.js
- Yarn
- TypeScript
- Parcel
- box2d-wasm

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

The production build is generated with the `/roulette/` public path. Cloudflare deployment support will be refined as the hosting work progresses.

## License

This project is distributed under the [MIT License](LICENSE).
