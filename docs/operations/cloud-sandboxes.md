# Cloud sandboxes as T3 environments

> Status: research and plan, 2026-10-05. Not implemented. Upstream issue with the same goal:
> [pingdotgg/t3code#14793](https://github.com/pingdotgg/t3code/issues/14793) (open, no maintainer reply);
> managed cloud workers ([#14620](https://github.com/pingdotgg/t3code/issues/14620)) were declined.

Goal: a new thread can run in a fresh cloud sandbox (Daytona or similar) that boots the project's dev
environment, instead of on the user's own server.

## How remote environments work today

- An **environment** is one running T3 server with its machine, files, provider logins and state. A
  project and its threads belong to one environment (`docs/internals/remote.md`). The remote side is the
  same `apps/server` started as `t3 serve --host --port --base-dir`; `t3 auth pairing create --json` mints a
  pairing credential and `t3 project add` registers a project.
- **Connections** (`packages/client-runtime/src/connection/model.ts`): `Primary`, `Bearer` (pairing URL
  `https://host/#token=…`), `Relay` (T3 Connect) and `Ssh`. `resolver.ts` turns each into HTTP and socket
  URLs plus a token and checks `/.well-known` against the expected environment ID.
- **T3 Connect** uses Clerk plus a Cloudflare Worker relay that gives each environment a managed tunnel,
  limited to 3 per user (`infra/relay/src/environments/ManagedTunnelLimits.ts`). One tunnel per sandbox
  doesn't scale without your own relay.
- **SSH environments are the template** (`packages/ssh/src/tunnel.ts`): over SSH the desktop downloads a
  release runtime to `~/.t3/runtime`, starts `serve` on loopback, waits for readiness, mints a pairing token
  and opens an `ssh -L` forward. Clients see it as `SshEnvironmentGateway { provision, prepare, disconnect }`
  (`packages/client-runtime/src/platform/capabilities.ts`).
- **Thread workspaces** (`apps/server/src/orchestration-v2/ThreadLaunchService.ts`): `root`,
  `existing_worktree` or `worktree`; setup scripts come from `t3.json` (`runOnWorktreeCreate`).
- **Choosing an environment for a new thread** already exists in the composer
  (`apps/web/src/components/BranchToolbarEnvironmentSelector.tsx`, `packages/client-runtime/src/load-balancing.ts`).
- **Previews** (`apps/web/src/browser/browserTargetResolver.ts`) only resolve environment ports on
  loopback or private hosts; a public host throws "needs the planned authenticated preview gateway".

Missing for per-thread sandboxes: a lifecycle (create on thread start, stop on archive, destroy on delete),
previews for public hosts, and keeping thread history, which lives in the sandbox's `statev2.sqlite` and
dies with it.

## Path 0: try it today without code changes

A small script with the Daytona TypeScript SDK:

1. Create a sandbox from a prepared snapshot in the EU region (`new Daytona({ target: 'eu' })`).
2. Start `dockerd`, clone the repo, `bun install`, `t3 project add`.
3. Run `t3 serve --host 0.0.0.0 --port 3773`, then `t3 auth pairing create --json`.
4. Print `https://3773-<sandbox-id>.proxy.daytona.works/#token=<credential>` and add it under
   **Settings → Connections → Add environment**.

Alternative: `sandbox.createSshAccess(minutes)` and an SSH environment `<token>@ssh.app.daytona.io`, reusing
the SSH launcher (the token expires; port forwarding through Daytona's gateway is unverified).

Recommended first setup: **one long-lived sandbox per project with worktrees inside**. It needs no T3
changes, keeps one Docker daemon, one set of logins and warm caches. Move to per-thread sandboxes once the
bootstrap is reliable.

## Path 1: per-thread sandboxes in the fork (about 2–3k lines with tests)

| Piece | Where | Size |
| --- | --- | --- |
| Sandbox broker: `provision({ requestId, repo, baseRef }) → { httpBaseUrl, wsBaseUrl, pairingToken, sandboxId }`, `prepare` (restart an auto-stopped sandbox, rotate tokens), `stop`, `destroy` | new `packages/sandbox` (Daytona adapter), modelled on `packages/ssh` | 600–1,000 |
| Broker host | **recommended: a service on a home T3 server** (`apps/server/src/sandbox/SandboxBroker.ts` with `sandbox.*` RPCs and an MCP tool), so web, mobile, agents and scheduled tasks can all use it. Alternatives: desktop main (desktop only, key on the laptop) or an external HTTP broker (#14793's proposal, most likely to be accepted upstream) | 300–800 |
| Connection kind `Sandbox` plus a resolver case and `SandboxEnvironmentGateway` | `connection/model.ts`, `resolver.ts`, `profileStore.ts`, `platform/capabilities.ts` | ~300 |
| "New sandbox" in the composer's environment picker: provision, register, wait for connected, launch with `workspaceStrategy: root` | `BranchToolbarEnvironmentSelector.tsx`, `ChatView.tsx`, client-runtime | 300–500 |
| Previews for public hosts: the server descriptor advertises a port-URL template (e.g. `https://{port}-{sandboxId}.proxy.daytona.works` or signed URLs); the resolver uses it | `packages/contracts/src/environment.ts`, `apps/server`, `browserTargetResolver.ts` | ~150 |
| Teardown: archive → stop or archive the sandbox, delete → destroy, plus a TTL reaper | client action plus broker; Daytona auto-stop, auto-archive, auto-delete | ~200 |

Add a **warm pool** (a few booted sandboxes waiting) to hide the 20–60 s cold start (an estimate).

**Thread history:** archiving a thread must stop or archive its sandbox, never delete it, until T3 can
export a thread's history (no export command exists, `docs/user/thread-migration.md`).

## Provider choice (checked 2026-10-05)

| Provider | Docker inside | Snapshots | Idle and persistence | Public ports | EU | Price |
| --- | --- | --- | --- | --- | --- | --- |
| **Daytona** | yes, documented (DinD snapshot, compose) | from a Dockerfile or image | auto-stop 15 min (configurable), archive, no auto-delete | `https://{port}-{id}.proxy.daytona.works`, token header or signed URL; SSH gateway | yes | $0.0504/vCPU-h + $0.0162/GiB-h |
| Vercel Sandbox | yes (root `dockerd` in Firecracker) | OCI images, filesystem snapshots | filesystem kept; 24 h per session | URL per port, up to 15 | yes (fra1, arn1, cdg1) | $0.128 per active CPU-h + $0.0212/GB-h |
| E2B | yes (template) | templates; pause keeps memory | 24 h on Pro | `{port}-{id}.e2b.app` | yes (tier unverified) | $0.0504/vCPU-h + $150/month Pro |
| Modal | alpha VM runtime only | filesystem incl. `/var/lib/docker` | 24 h max | tunnels | yes (1.15–1.75×) | ~$0.142/core-h |
| Fly Machines | yes | your image, volumes | stop or suspend | build your own routing | yes | ~$68/month for 2 perf CPU, 4 GB |
| Morph Cloud | yes | memory + disk, fast branching | pause, wake on HTTP | yes | not documented | $0.05 per compute unit |
| Codespaces | yes (DinD feature) | prebuilds | idle stop | `*.app.github.dev` | yes | $0.09/core-h |

**Recommendation: Daytona (EU)**, with Vercel Sandbox (fra1/arn1) as the one to compare against. E2B if
keeping running Postgres and dev servers in memory across pauses matters more than its 8 GB RAM cap.

Check on Daytona before committing:
- Egress is limited on account tiers 1–2; Docker Hub pulls and the Shopify tunnel need tier 3 or higher.
- Private previews use an `x-daytona-preview-token` header, which a browser can't send on a WebSocket; use
  a public sandbox or signed URLs. WebSockets through the preview proxy are unverified. The preview token
  grants shell access: never give it to clients.
- `dockerd` sometimes needs a manual start ([daytona#4461](https://github.com/daytonaio/daytona/issues/4461));
  snapshotting a DinD sandbox can fail with ENOSPC ([daytona#5156](https://github.com/daytonaio/daytona/issues/5156)).
- Auto-stop fires during long agent turns unless preview, SSH or SDK traffic resets it; `prepare` must
  restart the sandbox on reconnect.

## Booting a Bun + buncargo project (e.g. bulkhead) in a sandbox

- **Snapshot:** Ubuntu 24.04 with Docker engine and compose, git, `gh`, Bun at `.bun-version`, the fork's T3
  server runtime (the SSH launcher downloads releases, so a fork publishes its own archives or bakes the
  runtime in), `claude`, `codex`, the Infisical and Shopify CLIs, the repo cloned with `bun install` done,
  and `docker save` of the Postgres image loaded at boot (pulled images aren't in a Dockerfile snapshot).
- **Project file:** add a `t3.json` with `runOnWorktreeCreate: bun install` for the worktree route.
- **Postgres:** buncargo's Docker service runs inside; `bun run test` needs it, `lint` and `test:unit` don't.
- **Secrets:** a dev-only Infisical machine identity (Universal Auth, read on `dev`) injected as sandbox
  environment variables, not a `.env`. Whether buncargo's secrets support Universal Auth directly is
  unverified (fallback: `infisical login --method=universal-auth` at boot). Provider logins per sandbox
  (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, a Codex key) through `ProviderInstanceEnvironment`; a
  fine-grained GitHub token. Scope each narrowly: the agent can read them.
- **Shopify CLI is the hard part:** `shopify app dev` needs an interactive login, automation tokens don't
  cover `app dev`, and several sandboxes against one app fight over its dev URL. Use `bun run dev:local`
  (no Shopify CLI) in per-thread sandboxes, keep `app dev` on one sandbox per developer, or give each
  sandbox its own dev app config. With `app dev` in a sandbox, set
  `SHOPIFY_FLAG_TUNNEL_URL=https://<port>-<id>.proxy.daytona.works:443`; the sandbox must be public because
  Shopify's webhooks can't send Daytona's token header.

## Open questions

1. WebSockets through Daytona's or E2B's preview proxy; port forwarding through Daytona's SSH gateway.
2. buncargo with Infisical Universal Auth, and buncargo port isolation across worktrees in one sandbox.
3. Where the fork publishes its server runtime for sandboxes, and how snapshots are rebuilt on each update.
4. Every sandbox is an entry in Connections; grouping by repository identity merges them in the sidebar.
5. Whether to propose the broker hook upstream (#14793) to avoid carrying the diff in the fork.
