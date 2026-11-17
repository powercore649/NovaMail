import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [path.join(root, 'src', 'worker.js')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outfile: path.join(root, 'worker.js'),
  external: ['cloudflare:sockets'],
  logLevel: 'info',
});

await build({
  entryPoints: [path.join(root, 'src', 'worker.js')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  outfile: path.join(root, 'dist', 'worker.test.mjs'),
  plugins: [
    {
      name: 'sockets-node',
      setup(builder) {
        builder.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({
          path: path.join(root, 'scripts', 'socket-node.mjs'),
        }));
      },
    },
  ],
  logLevel: 'info',
});
