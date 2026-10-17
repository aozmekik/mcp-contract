import type { Options } from 'tsup';

const config: Options = {
  entry: { index: 'src/index.ts', cli: 'src/cli.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: { entry: { index: 'src/index.ts' } },
  sourcemap: true,
  clean: true,
  splitting: true,
  treeshake: true,
};

export default config;
