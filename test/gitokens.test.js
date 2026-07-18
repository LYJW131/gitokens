'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { missingTrailerLines, trailerLines, trailerOptions } = require('../bin/gitokens');
const cli = path.resolve(__dirname, '../bin/gitokens.js');

const stats = {
  perModel: new Map([
    ['claude-fable-5', { in: 32, out: 14850, cacheRead: 1740320, cacheWrite: 97995 }],
  ]),
};
const pricing = {
  'claude-fable-5': {
    input_cost_per_token: 0.001,
    output_cost_per_token: 0.0001,
    cache_read_input_token_cost: 0.000001,
    cache_creation_input_token_cost: 0.000005,
  },
};

test('all trailer lines are enabled by default', () => {
  const lines = trailerLines(stats, pricing);
  assert.deepEqual(
    lines.map((line) => line.slice(0, line.indexOf(':'))),
    ['AI-Model', 'AI-Tokens', 'AI-Cost-USD']
  );
});

test('each trailer line can be disabled independently', () => {
  assert.deepEqual(
    trailerLines(stats, pricing, { model: false, tokens: true, cost: false }),
    ['AI-Tokens: in=32, out=14850, cache-read=1740320, cache-write=97995']
  );
  assert.match(
    trailerLines(stats, pricing, { model: true, tokens: false, cost: false })[0],
    /^AI-Model:/
  );
  assert.match(
    trailerLines(stats, pricing, { model: false, tokens: false, cost: true })[0],
    /^AI-Cost-USD:/
  );
  assert.deepEqual(trailerLines(stats, pricing, { model: false, tokens: false, cost: false }), []);
});

test('only missing enabled trailers are appended', () => {
  const lines = trailerLines(stats, pricing);
  assert.deepEqual(missingTrailerLines('Subject\n\nAI-Model: existing\n', lines), lines.slice(1));
});

test('config command defaults on and stores independent repository overrides', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitokens-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);

  assert.deepEqual(trailerOptions(dir), { model: true, tokens: true, cost: true });
  assert.equal(
    execFileSync(process.execPath, [cli, 'config', 'tokens', 'off'], { cwd: dir, encoding: 'utf8' }),
    'tokens : off\n'
  );
  assert.deepEqual(trailerOptions(dir), { model: true, tokens: false, cost: true });
});
