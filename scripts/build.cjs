const { rmSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const root = resolve(__dirname, '..');
rmSync(resolve(root, 'dist'), { recursive: true, force: true });
const result = spawnSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
