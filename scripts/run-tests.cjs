const { readFileSync, rmSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const root = resolve(__dirname, '..');
const suites = JSON.parse(readFileSync(resolve(root, 'tests/suites.json'), 'utf8'));
const name = process.argv[2];
if (name !== '--all' && !suites[name]) {
  console.error('Usage: node scripts/run-tests.cjs <suite|--all>');
  process.exit(2);
}
function run(command, args, env = {}) {
  const result = spawnSync(command, args, { cwd: root, env: { ...process.env, LLM_LOG_PATH: resolve(root, '.test-build/logs/llm.log'), PROMPT_LOG_PATH: resolve(root, '.test-build/logs/prompt.log'), ...env }, stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  return result.status ?? 1;
}
rmSync(resolve(root, '.test-build'), { recursive: true, force: true });
if (run(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.test.json'])) process.exit(1);
mkdirSync(resolve(root, '.test-build/logs'), { recursive: true });
// CLI smoke fixtures execute the actual compiled agent.
if (run(process.execPath, [resolve(root, 'scripts/build.cjs')])) process.exit(1);
const selected = name === '--all' ? Object.values(suites) : [suites[name]];
const seen = new Set(), failed = [];
for (const suite of selected) {
  for (const file of suite.files) {
    if (seen.has(file)) continue;
    seen.add(file);
    console.log(`\nRunning ${file}`);
    const python = file.endsWith('.py');
    const target = file.endsWith('.ts') ? `.test-build/${file.replace(/\.ts$/, '.js')}` : file;
    if (run(python ? 'python3' : process.execPath, python ? ['-B', target] : [target], suite.env)) failed.push(file);
  }
}
console.log(`\n${seen.size - failed.length}/${seen.size} test files passed.`);
if (failed.length) console.error('Failed:\n' + failed.join('\n'));
process.exit(failed.length ? 1 : 0);
