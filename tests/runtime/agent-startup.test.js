'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const repo = process.cwd();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elastic-agent-startup-'));
try {
  for (const directory of ['dist', 'prompts']) fs.cpSync(path.join(repo, directory), path.join(root, directory), { recursive: true });
  for (const file of ['package.json', 'CLAUDE.md']) fs.copyFileSync(path.join(repo, file), path.join(root, file));
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/main.ts'), '// Smoke-test workspace entry\n');
  fs.writeFileSync(path.join(root, 'README.md'), 'Fixture repository for read-only verification.\n');
  const preload = path.join(root, 'fake-provider.cjs');
  fs.writeFileSync(preload, `
const fs = require('node:fs');
const path = require('node:path');
const read = fs.readFileSync, write = fs.writeFileSync;
// Never inspect or overwrite the real legacy runtime state.
fs.readFileSync = function(file, ...args) { return String(file) === '/tmp/data.json' ? '{}' : read.call(this, file, ...args); };
fs.writeFileSync = function(file, ...args) { return write.call(this, String(file) === '/tmp/data.json' ? path.join(__dirname, 'fixture-state.json') : file, ...args); };
global.fetch = async () => { throw new Error('Network disabled in smoke fixture'); };
const application = require('./dist/llm/application.js');
let calls = 0;
application.createRuntimeLlmAdapter = async () => ({
 provider: 'deepseek-v4', capabilities: { toolCalling: true, systemMessages: true, developerMessages: true },
 async generate(request) {
  calls++;
  if (calls === 3 || calls === 5) {
   if (!request.messages.some(m => m.role === 'tool' && JSON.stringify(m).includes('Fixture repository for read-only verification.'))) throw new Error('Missing successful file read in model context');
  }
  let message = { role: 'assistant', content: [] };
  if (calls === 1) message.content = [{ type: 'text', text: JSON.stringify({ requiresPlanning: true, reason: 'Inspect before planning' }) }];
  else if (calls === 2 || calls === 4) message.toolCalls = [{ id: 'read-' + calls, name: 'Read', arguments: { path: 'README.md', file_size: 47, read_offset: 0, read_length: 47 } }];
  else if (calls === 3) {
   if (!request.messages.some(m => m.role === 'tool')) throw new Error('Planning lost its research results');
   message.content = [{ type: 'text', text: JSON.stringify({ tldr: 'Inspect fixture', steps: [{ step_number: 1, tldr: 'Read the README and report what it contains' }], expected_outcome: 'Verified fixture' }) }];
  } else if (calls === 5) message.content = [{ type: 'text', text: String.fromCharCode(96).repeat(3) + 'json\\n' + JSON.stringify({ stepStatus: 'completed', summary: 'Read fixture README successfully', findings: ['Fixture contains the expected description'], suggestedStepUpdate: null, suggestedPlanUpdates: [], replanRequired: false, replanReason: null }) + '\\n' + String.fromCharCode(96).repeat(3) }];
  else throw new Error('Unexpected extra model call: ' + calls);
  fs.writeFileSync(path.join(__dirname, 'provider-calls.txt'), String(calls));
  return { model: request.model, finishReason: message.toolCalls ? 'tool_calls' : 'stop', message };
 }
});
`);
  const env = { PATH: process.env.PATH, HOME: root, ELASTIC_AGENT_RUN_STATE_PATH: path.join(root, 'run-state.json'), LLM_PROVIDER: 'deepseek-v4', ELAGENT_MEMORY_DISABLE: '1', LLM_LOG_PATH: path.join(root, 'llm.log') };
  const help = spawnSync(process.execPath, ['dist/main.js', '--help'], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /interrogate-memory/);
  const preview = spawnSync(process.execPath, ['dist/main.js', '--interrogate-memory', '--session-id', 'smoke', '--provider', 'deepseek-v4', 'Inspect fixture'], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).mode, 'memory-interrogation');
  const run = spawnSync(process.execPath, ['--require', preload, 'dist/main.js', '--provider', 'deepseek-v4', '--disable-classifier', 'Inspect README.md and report its contents'], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 0, (run.stderr + run.stdout).slice(-6000));
  assert.equal(fs.readFileSync(path.join(root, 'provider-calls.txt'), 'utf8'), '5');
  const events = fs.readFileSync(path.join(root, 'agent.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.some(event => event.event === 'plan'));
  assert.ok(events.some(event => event.event === 'step' && event.status === 'succeeded'));
  console.log('Built agent help, interrogation, research tools, execution tools, and completion smoke passed.');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
