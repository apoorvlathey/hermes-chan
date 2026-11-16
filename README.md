# HermesChan ☤

A small, friendly desktop chat for my [Hermes Agent](https://github.com/NousResearch/hermes-agent) bots.
There's one sidebar: **bots on top** (tap one to open its Bot Chat, with a blue dot when there's something new) and
**chats below** (every normal session from every bot, newest first, with routine/cron runs tucked away).

## Run

```bash
pnpm install
pnpm dev           # hot-reload dev
pnpm install-app   # build HermesChan.app and install/update it in /Applications
```

`install-app` packages with electron-builder (`dist/mac-arm64/`), ad-hoc signs the bundle, clears quarantine,
quits a running copy, and replaces `/Applications/HermesChan.app`. Re-run it after pulling changes.

## Config

First launch writes `~/.hermes-chan/config.json`:

```jsonc
{
  "bots": [
    // a server: runs `hermes gateway attach` over SSH and tunnels the gateway port
    { "id": "assistant", "name": "Assistant", "transport": { "kind": "ssh", "host": "my-server", "profile": "default" } },
    // a profile on this Mac
    { "id": "research", "name": "Research", "color": "hsl(200 70% 60%)", "transport": { "kind": "local", "profile": "research" } }
  ],
  "hiddenSources": ["cron", "tool", "kanban", "subagent"]
}
```

`host` is an entry in `~/.ssh/config` and must work with key auth (`BatchMode=yes`). Names, colours and avatars come
from each profile's Bot Mode metadata when it has any; the config values are fallbacks.

## How it talks to Hermes

- **Connection:** for each bot, `hermes -p <profile> gateway attach --json` gives a WebSocket URL plus a single-use
  ticket. SSH bots run it over a shared ControlMaster (`~/.hermes-chan/ssh/`) and forward the gateway's loopback port
  on that same master. Nothing changes on the VPS.
- **Protocol:** `vendor/hermes-shared` is Hermes's own renderer-free gateway client (`apps/shared/src`, MIT), copied
  in as is. `pnpm sync-shared` refreshes it from `~/.hermes/hermes-agent` after a Hermes update.
- **RPCs used:** `profiles.list` (roster + canonical Bot Chat), `session.list` (`scope: 'stored'` and live, merged),
  `session.resume`, `session.create`, `prompt.submit` (needs a `submission_id`), `session.interrupt`,
  `approval.respond`/`clarify.respond`, `profiles.get_asset`.
- **Unread dots** are local (`localStorage`): something is unread when its `last_active` is newer than the last time
  you looked at it.

## Layout

```
src/main/       Electron main: config, SSH/local transport, one GatewayClient per bot, IPC
src/preload/    window.hermes bridge
src/renderer/   React UI: store.ts (state + event routing), Sidebar, Chat, styles.css
scripts/        probe.ts (dump RPC shapes for a bot), cdp.ts (screenshot/eval a running app), sync-shared.sh
```

## Dev tips

```bash
pnpm probe my-server default             # what the gateway returns for profiles/sessions (or: pnpm probe local default)
pnpm build && pnpm exec electron . --remote-debugging-port=9333
pnpm tsx scripts/cdp.ts shot shot.png    # screenshot the running app
```
