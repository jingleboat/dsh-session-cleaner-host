# dsh-session-cleaner

A **DeepSeek Harness (DSH)** plugin — host half and Web client half in one bundle — that adds two
things to the DSH Web GUI:

1. **Delete a conversation** from the sidebar session menu, with a confirmation dialog.
2. **Quote / Ask from the right-click menu** — select text in a chat message, then right-click. The
   plugin takes over the context menu and shows **Copy / Quote / Ask**, with Copy first, exactly where
   the native menu item used to be:
   - **Copy** writes the selection to the clipboard (the same action as before, now drawn by us).
   - **Quote** inserts a Markdown quote block (role + turn metadata) into the composer.
   - **Ask** sends the selection plus your question to a *concurrent subagent* and streams the answer
     into the right sidebar, without interrupting the main conversation.

[中文说明](README.zh.md)

---

## Features

| Surface | What it does |
| --- | --- |
| `sidebar.workspaces.session.menu.item` | **Delete session** — stops a running session (flush + detach), detaches it from the workspace registry, invalidates its projection cache, physically removes the session directory, cleans its spill directory, cascades to its `origin: subagent` children (fork branches are never cascaded), then broadcasts `api-session/removed`. |
| `shell.overlay` | Selection **right-click menu**: **Copy** (clipboard) / **Quote** (insert into the composer) / **Ask** (concurrent subagent question). The menu is drawn by the plugin because the desktop app builds its native context menu in the Electron main process, which a renderer plugin cannot extend; `preventDefault()` on `contextmenu` keeps the native menu from popping. |
| `sidebar.right.pane.tab` | **Follow-up** tab: streams the ask subagent's answer (reasoning + text) in the right sidebar. |

### Ask reuses one subagent

Every question does **not** spawn a new subagent. The plugin keeps a single continuable subagent
labelled `ask` per parent session and delivers the next question to it (discovering the existing one
through the official `subagents.listChildren()` catalog, so it survives a host restart).

### Scoped auto-compaction for the ask subagent

Because the reused `ask` subagent's context grows with every question, the host registers its own
`agent/pre-step` listener that calls `ctx.compaction.compactIfNeeded(agent, "pressure", signal)`
**only for this plugin's own ask subagents**. Global automatic compaction stays off
(`compaction-basic` is mounted with `auto: false`) — the main conversation is unaffected.

---

## Install

The plugin is a normal DSH bundle. Add it to your profile's `package.json`:

```jsonc
{
  "dependencies": {
    "@local/dsh-session-cleaner-host": "link:/absolute/path/to/dsh-session-cleaner-host"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // …
        "@local/dsh-session-cleaner-host"
      ]
    }
  }
}
```

The package name must be used consistently in three places:

- `package.json` → `name`
- `client.js` → `window.__ModuleLoader__.load({ id: "…" })`
- the profile's `dsh.profile.bundles` entry

Then add the compaction backend to your profile patch layer
(`~/.dsh/profiles/<profile>/cordis.patch.yml`), which is applied **after** every bundle layer:

```yaml
# Compaction backend for the ask subagent's scoped auto-compaction.
# `auto: false` keeps GLOBAL automatic compaction off; the plugin calls
# ctx.compaction.compactIfNeeded() itself, scoped to its own ask subagents.
- id: compaction-basic
  name: "@deepseek-ai/dsh-compaction-basic"
  disabled: false
  config:
    auto: false
```

> Keep this row in the **profile** patch, not in this package's bundle patch: installing a plugin
> must not silently enable another package for the whole profile.

Restart DSH after changing host-side code, then reload the page. Verify which build is live:

```bash
curl -s http://127.0.0.1:19387/api/dsh-session-cleaner/version
# {"ok":true,"name":"dsh-session-cleaner","build":"…","features":{…}}
```

---

## Usage

**Quote / Ask**

1. Select some text in a chat message.
2. Right-click inside the selection.
3. The context menu opens with **Copy / Quote / Ask** (Copy first, then a separator).
4. *Quote* appends a quoted block to the composer. *Ask* swaps the menu for a question box; send it
   and the **Follow-up** tab opens in the right sidebar with the streamed answer.

Right-clicking in the composer, or right-clicking without a selection, keeps the normal system menu
(cut / paste / select all).

**Delete a conversation**

Sidebar session row → `⋯` → **Delete session**. Deleting the currently open session stops it and
switches the page to a new session.

---

## HTTP API

All routes are served by the plugin's host half (same-origin, browser cookie auth):

| Method | Path | Body | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/dsh-session-cleaner/version` | — | Which build is live (diagnostics). |
| `POST` | `/api/dsh-session-cleaner/ask` | `{ sessionId, text }` | Deliver a question to the reused `ask` subagent, creating it once if needed. |
| `POST` | `/api/dsh-session-cleaner/delete-session` | `{ sessionId }` | Delete a whole session (and cascade to its subagent children). |
| `POST` | `/api/dsh-session-cleaner/delete-subagent` | `{ childId, parentId }` | Delete one direct subagent child. Guarded by a lineage check. |
| `POST` | `/api/dsh-session-cleaner/terminate-children` | `{ sessionId }` | Drain every continuable descendant of a session. |

---

## Design notes and hard-won constraints

These are the constraints that shape the implementation. Several of them were established by reading
the shipped DSH sources, and getting any of them wrong produces silent data loss.

1. **DSH exposes no "delete a session" API.** `sessions`, `sessionPersistence`,
   `sessionProjectionCache` and `sessionController` are all append-only; the persistence seam documents
   *"Nothing deletes session files … the seam has no deletion API."* This plugin therefore performs
   deliberate on-disk surgery — and compensates with strict identity checks.
2. **Never rewrite another session's log.** The plugin originally rewrote the parent log to drop a
   `subagent/catalog` row. Session logs are append-only and may be written concurrently by the host, so
   a read → filter → atomic-rename could truncate a conversation. `rewriteParentLog` now defaults to
   **`false`**.
3. **Session directory lookup is identity-verified.** Any candidate directory must yield a log whose
   header `id` equals the requested session id; the plugin never falls back to guessing.
4. **`subagent/catalog` is append-only.** There is no supported way to remove a row, and removing the
   child's session behind a live row produces a dangling entry. The plugin does not touch catalog rows.
5. **Subagent operations are lineage-guarded.** `delete-subagent` refuses unless
   `header.parentSession === parentId && header.origin === "subagent"`, and refuses
   `childId === parentId` — without that check, "delete the subagent" can delete the conversation you
   are looking at.
6. **Compaction needs a *live idle* agent.** `compaction.compactNow(agent, signal)` takes a
   `ManualCompactAgentContext` (it needs `runMaintenance()`), but a continuable subagent is **not
   resident after its turn settles**. There is therefore no supported way to compact a *finished*
   subagent on demand; compaction only works at `agent/pre-step`, while the turn is open and the agent
   is alive. That is why the plugin hooks `agent/pre-step` instead of offering a button.
7. **Self-contained by design.** The host half imports **only Node builtins** — no `@deepseek-ai/*`
   runtime dependency, so the plugin cannot shadow the official packages in a profile's
   `node_modules`. `package.json` declares no dependencies at all.
8. **Selections are quoted verbatim** and capped at 2000 characters; a selection spanning two messages
   or inside a streaming message is ignored.

---

## Tests

```powershell
npm test
```

Two self-contained suites, no DSH, no browser and no real session data:

| Suite | Covers |
| --- | --- |
| `test/internals.test.mjs` | host half: zstd session-log framing, projection keys, log decode/encode |
| `test/client-context-menu.test.mjs` | client half: loads the real `client.js` through a minimal DOM/React/ctx stub, then checks the right-click path — capture-phase listener, `preventDefault()` only on a selected message, menu order (Copy → Quote → Ask), viewport clamping, native-menu passthrough in the composer / without a selection, and listener cleanup on dispose |

`test/verify-served-bundle.mjs` is an optional live check (needs a running DSH): it recomputes the
host's bundle rev from `client.js` metadata, fetches the exact bundle the host is serving, and fails if
the running host still hands out a stale copy. Point it at another instance with `DSH_WEB_URL`.

---

## Compatibility

Developed and tested against **DSH `0.2.0-rc.2`** (the desktop/Web profile: `@deepseek-ai/dsh-base` +
`@deepseek-ai/dsh-web-app`). It relies on public seams — `slots`, `locale`, `sessions`, `subagents`,
`agents`, `sessionPersistence`, `sessionProjectionCache`, `workspaceRegistry`, `spillStore`,
`compaction` — and degrades gracefully when an optional service is missing.

---

## License

MIT — see [LICENSE](LICENSE).
