# Transferring a thread to another environment

You can move a thread to another connected environment, for example from your laptop to a cloud
machine, and keep working with the same agent session there. Choose **Transfer thread** in the
thread's workspace panel, choose **Transfer to environment…** from the thread's menu, or run the
command from the command palette. Pick the environment and confirm. The action appears when
both environments run a T3 Code version that supports transfers.

Your client carries the thread between the two environments, so they do not need to reach each
other. Keep both connected until the transfer finishes.

## Before transferring

- If the agent is working, the transfer stops it and cancels queued messages first.
- Only threads in a Git repository can move. Transfers match projects by repository. When the
  destination has no project for it, it clones the source's `origin` remote into its projects folder
  and adds the project, using the destination's own Git credentials.
- If the thread ran in its own worktree, push its branch, or check it out on the destination. The
  destination creates or reuses a worktree for that branch.
- Sign in to the same provider on the destination. Claude and Codex threads can be transferred.

The destination checks these before anything is copied. It also warns when its checkout is
behind, ahead of, or different from the source, or when the source has uncommitted changes. When
the destination is only behind, you can fast-forward it to the source's commit as part of the
transfer.

## After transferring

The thread continues on the destination with its history and the provider's own session, so the
agent remembers the conversation. The original is archived and becomes read-only, with a link to its
copy. To move the thread back, transfer the copy.

These stay on the source:

- Diffs and rewinds for turns before the transfer
- Uncommitted changes
- Running background tasks and machine-local MCP servers

## If a transfer does not finish

If a transfer stops partway, the original shows **Finish transfer** and **Unlock**. Finish picks up
where the transfer stopped. Unlock lets you keep working on the original. If the destination
already received its copy, unlocking leaves you with two copies of the conversation that continue
separately.
