import { build } from 'esbuild';
import fs from 'node:fs';

fs.rmSync('dist', { recursive: true, force: true });
fs.mkdirSync('dist', { recursive: true });

const shared = { bundle: true, sourcemap: true, target: 'es2023', logLevel: 'warning' };

await build({ ...shared, entryPoints: ['src/main/index.ts'], outfile: 'dist/main.cjs', platform: 'node', format: 'cjs', external: ['electron'] });
await build({ ...shared, entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload.cjs', platform: 'node', format: 'cjs', external: ['electron'] });
await build({ ...shared, entryPoints: ['src/renderer/app.ts'], outfile: 'dist/app.js', platform: 'browser', format: 'iife' });

fs.copyFileSync('src/renderer/index.html', 'dist/index.html');
fs.copyFileSync('src/renderer/styles.css', 'dist/styles.css');
fs.copyFileSync('src/renderer/chevron.svg', 'dist/chevron.svg');
