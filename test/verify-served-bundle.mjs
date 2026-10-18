// Verify that the running DSH host serves the current client.js from disk.
//
// The host exposes each plugin's client bundle at a cache-busted combo URL whose
// `rev` is derived from the file's own metadata (see @deepseek-ai/dsh-client-modules
// artifactRevision): sha1("plugin-artifact\0" + framed mtimeMs/ctimeMs/size), 12 hex chars.
// Recomputing it here lets us fetch exactly the bundle the host is serving without
// subscribing to the SSE graph, so the check stays a plain request/response.
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

const BASE = (process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387').replace(/\/+$/, '')
const ID = '@local/dsh-session-cleaner-host'
const CLIENT_PATH = new URL('../client.js', import.meta.url)

function framedHash(domain, parts) {
  const hash = createHash('sha1').update(domain).update('\0')
  for (const part of parts) hash.update(`${String(Buffer.byteLength(part))}:`).update(part)
  return hash.digest('hex').slice(0, 12)
}

const stats = statSync(CLIENT_PATH)
const rev = framedHash('plugin-artifact', [String(stats.mtimeMs), String(stats.ctimeMs), String(stats.size)])
const url = `plugins/??${ID}/client.js&rev=${rev}`

const response = await fetch(`${BASE}/${url}`)
const text = await response.text()
console.log(`local client.js: ${stats.size} bytes`)
console.log(`graph row (recomputed rev): ${url}`)
console.log(`served: HTTP ${response.status}, ${text.length} bytes`)

const local = readFileSync(CLIENT_PATH, 'utf8')
const must = ['dsc-ctxMenu', 'SelectionContextMenu', 'nodeType === 1', 'action.copied', 'data-chat-anchor-key']
const mustNot = ['dsc-popover', 'SelectionPopover']
let ok = response.status === 200
for (const needle of must) {
  const present = text.includes(needle)
  ok &&= present
  console.log(`  ${present ? 'present' : 'MISSING'}  ${needle}`)
}
for (const needle of mustNot) {
  const present = text.includes(needle)
  ok &&= !present
  console.log(`  ${present ? 'STALE  ' : 'absent '}  ${needle}`)
}
// The served bytes are the host's prepared copy (debug directives stripped), so the
// lengths differ by design; the rev already proves which file generation it read.
console.log(`  local ${local.length} chars / served ${text.length} chars (host-prepared copy)`)
console.log(ok ? '\nOK: the running host serves the current right-click menu build' : '\nFAIL: the host is serving a stale bundle')
process.exit(ok ? 0 : 1)
