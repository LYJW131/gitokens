# gitokens

Record AI token usage while you vibe-code, and stamp it onto your next commit.

Between two commits, gitokens aggregates Claude Code and Codex CLI token usage (per model,
including cache reads/writes) from the local transcript logs, and a
`prepare-commit-msg` git hook appends the result to your commit message as
machine-readable [git trailers](https://git-scm.com/docs/git-interpret-trailers):

```
Add user authentication

AI-Tokens: model=claude-fable-5 in=1204 out=8455 cache-read=203941 cache-write=40673
```

## How it works

- Claude Code writes every session transcript to `~/.claude/projects/<project>/*.jsonl`;
  each assistant message carries `model` and `usage` (input/output/cache tokens).
- Codex CLI writes rollout files to `~/.codex/sessions/YYYY/MM/DD/*.jsonl`;
  gitokens diffs the cumulative `token_count` counters (immune to duplicate
  events) and attributes them to the model from the surrounding `turn_context`.
- `gitokens` filters those entries to this repository (`cwd` match) and to the
  window since the last commit (a checkpoint file in `.git/`, updated by a
  `post-commit` hook), deduplicates streamed chunks by message + request id,
  and sums tokens per model.
- The `prepare-commit-msg` hook appends one `AI-Tokens:` trailer per model via
  `git interpret-trailers`, so the data is queryable with plain git:

```sh
git log --format='%h %(trailers:key=AI-Tokens,valueonly)'
```

## Install

```sh
node bin/gitokens.js install   # from inside the target repository
```

This installs `prepare-commit-msg` and `post-commit` hooks (it refuses to
overwrite hooks it doesn't manage) and initializes the checkpoint.

## Commands

| command      | what it does                                                    |
|--------------|-----------------------------------------------------------------|
| `install`    | install the git hooks in the current repository                 |
| `status`     | show AI usage since the last commit                             |
| `trailer`    | print trailers, or append them to a commit-msg file (hook mode) |
| `checkpoint` | reset the usage window to now                                   |

## Notes & limitations

- Attribution is by time window: everything used between two commits counts
  toward the next commit, even chatter unrelated to the change.
- Merge, squash and amend commits are skipped.
- The transcript formats are internal to Claude Code / Codex and may change
  between versions.
- Sessions running in detached worktrees outside the repository root (e.g.
  Codex's `~/.codex/worktrees/...`) are not attributed to the repository.
- Codex does not report cache writes, so `cache-write=0` for GPT models.
- Set `GITOKENS_SINCE=<ISO date>` to override the window start for ad-hoc
  queries, e.g. `GITOKENS_SINCE=2026-07-01 gitokens status`.
- Gemini CLI support is a planned addition.
