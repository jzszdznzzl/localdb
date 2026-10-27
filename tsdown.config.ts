import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  platform: 'node',
  format: 'esm',
  dts: true,
  clean: true,
  // Published libraries stay readable, so stack traces in users' apps point at real names.
  minify: false,
  sourcemap: true,
  publint: { level: 'warning' },
  attw: { profile: 'esm-only', level: 'error' },
  // npm only ships what `files` lists, and the MIT license must travel with every copy.
  copy: [{ from: `${import.meta.dirname}/LICENSE` }],
  deps: { onlyBundle: [] },
});
