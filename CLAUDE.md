# inline-agent-widget — agent instructions

## Before `gh pr create` or pushing new commits to an open PR

Run the `inline-agent-widget-pr-review` skill against the intended diff (merge base of base branch → head). The skill is installed at `~/.claude/skills/inline-agent-widget-pr-review` (symlinked from `/Users/surs/cc-shopper-agent-docs/claude-skills/inline-agent-widget-pr-review`, branch `codex/inline-agent-widget-pr-review`).

The skill checks:
- First-turn connection / welcome / echo ordering
- Failure + retry paths — including manual recovery after automatic retries exhaust
- Session identity across reconnect, restore, SPA PDP nav
- Stale async work (timers, waiters, listeners) on unmount / config replacement
- Context + presentation changes that must not reconnect

Fix confirmed findings in the same branch, rerun affected validation, then re-review the final diff so the PR body describes what will actually ship. Metadata-only edits (title, description, labels) don't require re-review.

The skill alone does not authorize edits, commits, pushes, or GitHub publication — those remain explicit user requests.
