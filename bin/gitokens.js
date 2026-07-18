#!/usr/bin/env node
'use strict';

// gitokens — record AI (Claude Code) token usage between commits and
// append it to the next commit message as git trailers.
//
// Data source: Claude Code transcript JSONL files under ~/.claude/projects/.
// Aggregation window: entries with timestamp > checkpoint (written on each
// commit by the post-commit hook; falls back to last commit time).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const MARKER = '# gitokens-hook';

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...opts }).trim();
}

function repoRoot() {
  try {
    return git(['rev-parse', '--show-toplevel']);
  } catch {
    die('not inside a git repository');
  }
}

function gitDir(root) {
  return git(['rev-parse', '--absolute-git-dir'], { cwd: root });
}

function die(msg) {
  process.stderr.write(`gitokens: ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------- checkpoint

function checkpointFile(root) {
  return path.join(gitDir(root), 'gitokens-checkpoint');
}

function readCheckpoint(root) {
  try {
    const t = Date.parse(fs.readFileSync(checkpointFile(root), 'utf8').trim());
    if (!Number.isNaN(t)) return t;
  } catch {}
  // fall back to the last commit's committer time
  try {
    return (
      Number(git(['log', '-1', '--format=%ct'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })) * 1000
    );
  } catch {}
  return 0;
}

function writeCheckpoint(root, ms) {
  fs.writeFileSync(checkpointFile(root), new Date(ms).toISOString() + '\n');
}

// ---------------------------------------------------------------- collection

function claudeProjectDirs() {
  const dirs = [];
  for (const base of [
    path.join(os.homedir(), '.claude', 'projects'),
    path.join(os.homedir(), '.config', 'claude', 'projects'),
  ]) {
    try {
      for (const d of fs.readdirSync(base)) dirs.push(path.join(base, d));
    } catch {}
  }
  return dirs;
}

// Claude Code encodes a project cwd by replacing non-alphanumerics with '-'.
function encodePath(p) {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

function* jsonlFiles(root, sinceMs) {
  const enc = encodePath(root);
  for (const dir of claudeProjectDirs()) {
    const name = path.basename(dir);
    // include the repo's own project dir and any subdirectory project dirs
    if (name !== enc && !name.startsWith(enc + '-')) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(dir, f);
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.mtimeMs <= sinceMs) continue; // untouched since checkpoint
      yield full;
    }
  }
}

function collect(root, sinceMs) {
  const perModel = new Map(); // model -> {in, out, cacheRead, cacheWrite}
  const seen = new Set();
  const sessions = new Set();
  let latest = sinceMs;

  for (const file of jsonlFiles(root, sinceMs)) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const m = o.message;
      if (!m || m.role !== 'assistant' || !m.usage) continue;
      if (!m.model || m.model === '<synthetic>') continue;
      const ts = Date.parse(o.timestamp);
      if (Number.isNaN(ts) || ts <= sinceMs) continue;
      if (o.cwd && o.cwd !== root && !o.cwd.startsWith(root + path.sep)) continue;
      const key = (m.id || '') + ':' + (o.requestId || o.uuid || '');
      if (seen.has(key)) continue; // streamed chunks repeat message ids
      seen.add(key);

      const u = m.usage;
      const agg = perModel.get(m.model) || { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
      agg.in += u.input_tokens || 0;
      agg.out += u.output_tokens || 0;
      agg.cacheRead += u.cache_read_input_tokens || 0;
      agg.cacheWrite += u.cache_creation_input_tokens || 0;
      perModel.set(m.model, agg);
      if (o.sessionId) sessions.add(o.sessionId);
      if (ts > latest) latest = ts;
    }
  }
  return { perModel, sessions: sessions.size, latest };
}

// ------------------------------------------------------------------ trailers

function trailerLines(stats) {
  const lines = [];
  const models = [...stats.perModel.keys()].sort();
  for (const model of models) {
    const a = stats.perModel.get(model);
    lines.push(
      `AI-Tokens: model=${model} in=${a.in} out=${a.out} cache-read=${a.cacheRead} cache-write=${a.cacheWrite}`
    );
  }
  return lines;
}

function appendTrailers(msgFile, lines) {
  const args = ['interpret-trailers', '--in-place'];
  for (const l of lines) {
    const i = l.indexOf(': ');
    args.push('--trailer', `${l.slice(0, i)}=${l.slice(i + 2)}`);
  }
  args.push(msgFile);
  git(args);
}

// --------------------------------------------------------------------- hooks

const HOOK_PREPARE = (self) => `#!/bin/sh
${MARKER}
# Appends AI token-usage trailers to the commit message.
case "$2" in merge|squash|commit) exit 0 ;; esac
node "${self}" trailer "$1" || true
`;

const HOOK_POST = (self) => `#!/bin/sh
${MARKER}
# Records the usage checkpoint after each commit.
node "${self}" checkpoint || true
`;

function installHook(hooksDir, name, content) {
  const file = path.join(hooksDir, name);
  if (fs.existsSync(file)) {
    const cur = fs.readFileSync(file, 'utf8');
    if (!cur.includes(MARKER)) {
      die(
        `${file} already exists and is not managed by gitokens.\n` +
          `  Add this line to it manually:\n    node "${path.resolve(__filename)}" ` +
          (name === 'post-commit' ? 'checkpoint' : 'trailer "$1"')
      );
    }
  }
  fs.writeFileSync(file, content);
  fs.chmodSync(file, 0o755);
  console.log(`installed ${file}`);
}

// ---------------------------------------------------------------------- main

function fmtNum(n) {
  return n.toLocaleString('en-US');
}

function main() {
  const [cmd, arg] = process.argv.slice(2);
  const root = repoRoot();

  switch (cmd) {
    case 'status': {
      const since = readCheckpoint(root);
      const stats = collect(root, since);
      console.log(`window start : ${since ? new Date(since).toISOString() : '(beginning)'}`);
      console.log(`sessions     : ${stats.sessions}`);
      if (stats.perModel.size === 0) {
        console.log('no AI usage recorded in this window.');
        break;
      }
      for (const [model, a] of stats.perModel) {
        console.log(
          `${model}: in=${fmtNum(a.in)} out=${fmtNum(a.out)} ` +
            `cache-read=${fmtNum(a.cacheRead)} cache-write=${fmtNum(a.cacheWrite)}`
        );
      }
      break;
    }

    case 'trailer': {
      // called by prepare-commit-msg with the message file path
      const since = readCheckpoint(root);
      const stats = collect(root, since);
      const lines = trailerLines(stats);
      if (lines.length === 0) break;
      if (arg) {
        const existing = fs.readFileSync(arg, 'utf8');
        if (!existing.includes('AI-Tokens:')) appendTrailers(arg, lines);
      } else {
        console.log(lines.join('\n'));
      }
      break;
    }

    case 'checkpoint': {
      writeCheckpoint(root, Date.now());
      break;
    }

    case 'install': {
      let hooksPath = '';
      try {
        hooksPath = git(['config', '--get', 'core.hooksPath'], { cwd: root });
      } catch {}
      const hooksDir = hooksPath
        ? path.resolve(root, hooksPath)
        : path.join(gitDir(root), 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      const self = path.resolve(__filename);
      installHook(hooksDir, 'prepare-commit-msg', HOOK_PREPARE(self));
      installHook(hooksDir, 'post-commit', HOOK_POST(self));
      if (!fs.existsSync(checkpointFile(root))) writeCheckpoint(root, Date.now());
      break;
    }

    default:
      console.log(`usage: gitokens <command>

  install      install prepare-commit-msg + post-commit hooks in this repo
  status       show AI token usage since the last commit/checkpoint
  trailer      print trailers (or append to a commit-msg file when given a path)
  checkpoint   reset the usage window to now`);
      process.exit(cmd ? 1 : 0);
  }
}

main();
