# Transferring a thread to another environment

You can move a thread to another connected environment, for example from your laptop to a cloud
machine, and keep working with the same agent session there. Choose **Transfer thread** in the
thread's workspace panel, choose **Transfer to environment…** from the thread's menu, or run the
command from the command palette. Pick the environment and confirm. The action appears when
both environments run a T3 Code version that supports transfers.

Your client carries the thread between the two environments, so they do not need to reach each
other. Keep both connected until the transfer finishes.

## Before transferring

- You can transfer a thread while the agent is working. The transfer stops it and cancels queued
  messages, and the agent continues where it left off on the destination.
- Only threads in a Git repository can move. Transfers match projects by repository. When the
  destination has no project for it, it clones the source's `origin` remote into its projects folder
  and adds the project, using the destination's own Git credentials.
- If the thread ran in its own worktree, the destination creates or reuses a worktree for its
  branch. The branch does not need to be pushed. A new worktree or clone runs the project's setup
  script, the one set to run on worktree creation, before the agent continues.
- Sign in to the same provider on the destination. Claude and Codex threads can be transferred.

The destination checks these before anything is copied.

## Your code comes along

The thread continues on the same code it had. The source pushes its unpushed commits and
uncommitted files to a temporary ref on `origin`, without pushing or changing its branch. The
destination moves its checkout to the source's commit and restores those files as uncommitted
changes. The temporary ref is deleted when the transfer finishes. Files your `.gitignore` excludes,
such as `.env`, are not carried.

The destination keeps its own code instead, and warns you, when its checkout has uncommitted
changes, is on another branch, or has commits the source does not. If the source cannot push, for
example without write access to `origin`, the destination warns about what stays behind. When the
destination is only behind,
you can still fast-forward it to the source's commit as part of the transfer.

## After transferring

Your client opens the thread on the destination. It continues there with its history and the
provider's own session, so the agent remembers the conversation. The original is archived and
becomes read-only, with a link to its copy. To move the thread back, transfer the copy.

These stay on the source:

- Diffs and rewinds for turns before the transfer
- Running background tasks and machine-local MCP servers

## If a transfer does not finish

If a transfer stops partway, the original shows **Finish transfer** and **Unlock**. Finish picks up
where the transfer stopped. Unlock lets you keep working on the original. If the destination
already received its copy, unlocking leaves you with two copies of the conversation that continue
separately.
