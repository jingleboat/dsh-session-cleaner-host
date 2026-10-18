/**
 * dsh-session-cleaner — DeepSeek Harness 会话清理 + 追问插件（宿主半边）。
 *
 * 提供两项能力：
 *  1. 删除整段会话：运行中会话先 flush + detach，再走 workspaceRegistry 移除
 *     工作区登记 → 作废投影缓存 → 物理删除会话目录 → 清理 spill → 级联删除
 *     subagent 子会话（fork 分支不级联）→ 广播 api-session/removed。
 *  2. 追问（并发）：用 subagents 服务派生子 agent（继承父 agent 的模型路由），
 *     并发回答，不打断主会话。
 *
 * HTTP API（供客户端 UI 使用）：
 *  - POST /api/dsh-session-cleaner/delete-session  { sessionId }
 *  - POST /api/dsh-session-cleaner/ask             { sessionId, text } → { childId }
 *
 * 自包含：只依赖 Node 内置模块，不 import 任何 @deepseek-ai 包。
 */

import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import fsp from "node:fs/promises";
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

export const name = "dsh-session-cleaner";
export const inject = ["webServer"];

/** 供 /version 诊断：确认当前运行的是哪一版插件代码。 */
const PLUGIN_BUILD = "2026-10-18.ctxmenu-quote-ask";
const PLUGIN_FEATURES = { askReuse: true, askLabel: "ask", verifiedSessionDir: true, askAutoCompact: true, contextMenuQuote: true };

const DEFAULTS = {
  /** 会话存储根目录；留空 = $DSH_HOME/sessions */
  sessionsRoot: "",
  /** 投影缓存根目录；留空 = $DSH_HOME/storages/session_projcache */
  projcacheRoot: "",
  /** 重写日志时给 zstd 帧加校验和（与官方写入一致） */
  zstdChecksum: true,
  /** 是否注册 HTTP API */
  enableHttpApi: true,
  /** 是否允许改写父会话日志以移除子智能体目录行（默认关：与官方 append-only 契约冲突，有截断风险） */
  rewriteParentLog: false,
  /**
   * ask 子智能体在**下一次提问的 pre-step**按上下文压力自动压缩（作用域内，仅限本插件的 ask 子会话）。
   * 为什么必须在这里：compactNow 要求"活的空闲 Agent"，而可继续子会话 settle 后就不再驻留，
   * 所以"答完之后手动压缩"没有官方入口；只有轮次打开、agent 活着时（pre-step）才压得动。
   */
  askAutoCompact: true,
};

const ZSTD_MAGIC = 4247762216; // 0xFD2FB528 LE
const LOG_FILE_PATTERN = /^session\.v\d+\.jsonl(\.zstd)?$/;

/** 可选服务读取；缺失返回 undefined。 */
function svc(ctx, key) {
  try {
    return ctx.get(key);
  } catch {
    return undefined;
  }
}

function dshHome() {
  const env = process.env.DSH_HOME;
  return env && env.length > 0 ? env : join(homedir(), ".dsh");
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------ */
/* 路径编码 —— 与 @deepseek-ai/dsh-session-persistence-jsonl 完全一致   */
/* ------------------------------------------------------------------ */

/** 任意字符串 → 单一路径段（对全部 UTF-16 字符串单射）。 */
function encodeSegment(raw) {
  if (raw.length === 0) throw new Error("cannot encode an empty path segment");
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
  }
  return out;
}

/** 项目路径 → 可读目录键（分隔符折叠 + ~XXXX 转义，截断 251）。 */
function projectKey(cwd) {
  if (cwd.length === 0) throw new Error("cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/* ------------------------------------------------------------------ */
/* zstd 帧容器 —— 与官方后端相同的多帧结构                              */
/* ------------------------------------------------------------------ */

/** 扫描完整 zstd 帧边界（结构校验，不解压）；尾帧不完整则丢弃（与官方修复一致）。 */
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break; // torn tail
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`corrupt zstd session log: invalid frame magic at byte ${offset}`);
    offset += 4;
    if (offset === buffer.length) break;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`corrupt zstd session log: reserved frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) {
        offset = start;
        break;
      }
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`corrupt zstd session log: reserved block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) {
        offset = start;
        break;
      }
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (offset === start) break; // torn final frame
    if (checksum) {
      if (buffer.length - offset < 4) break;
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return frames;
}

/** 缓冲区是否以 zstd 帧魔数开头（明文 generation 则不是）。 */
function isZstdBuffer(buffer) {
  return buffer.length >= 4 && buffer.readUInt32LE(0) === ZSTD_MAGIC;
}

/** 解码会话日志文件 → JSONL 行数组（自动识别 zstd / 明文）。 */
function decodeSessionLog(buffer) {
  if (!isZstdBuffer(buffer)) {
    return buffer.toString("utf8").split(/\r?\n/).filter((line) => line.length > 0);
  }
  const frames = scanZstdFrames(buffer);
  let text = "";
  for (const frame of frames) {
    text += zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString("utf8");
  }
  return text.split(/\r?\n/).filter((line) => line.length > 0);
}

/** 编码 JSONL 行数组 → 单帧 zstd（带校验和，与官方写入一致）。 */
function encodeSessionLog(lines, checksum) {
  const text = lines.join("\n") + (lines.length > 0 ? "\n" : "");
  const params =
    checksum && zlibConstants.ZSTD_c_checksumFlag !== undefined
      ? { params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 } }
      : {};
  return zstdCompressSync(Buffer.from(text, "utf8"), params);
}

/** 同目录临时文件 + rename 的原子写。 */
async function atomicWrite(file, buffer) {
  const tmp = join(dirname(file), `.${basename(file)}.tmp-${randomUUID()}`);
  await fsp.writeFile(tmp, buffer);
  try {
    await fsp.rename(tmp, file);
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* 会话目录定位                                                        */
/* ------------------------------------------------------------------ */

async function dirExists(dir) {
  try {
    return (await fsp.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 读取某个会话目录里首个日志文件记录的 header（唯一可信身份来源）。
 * 会话日志首行即 header 事件（type:"session"，含 id/parentSession/origin/cwd）。
 */
async function headerOfDir(dir) {
  for (const file of await sessionLogFiles(dir)) {
    try {
      const lines = decodeSessionLog(await fsp.readFile(file));
      if (lines.length === 0) continue;
      const parsed = JSON.parse(lines[0]);
      const header = parsed?.data ?? parsed;
      if (header !== null && typeof header === "object" && typeof header.id === "string") return header;
    } catch {
      /* 试下一个 generation / 换下一份日志 */
    }
  }
  return undefined;
}

/**
 * 定位某个会话在磁盘上的目录（身份校验式：任何命中都必须确认目录内日志的 header.id === id）。
 * 策略（借鉴 @michengai/dsh-archive-manager）：
 *  1. 官方 sessionPersistence.locate(header) 直接解析日志工件路径（目录 = dirname）；
 *  2. header.cwd + 官方目录编码规则计算精确路径；
 *  3. 最后在 sessionsRoot 下按编码后的会话名做深度 3 的扫描。
 * 找不到（或身份不符）一律返回 undefined，绝不猜。
 */
async function findSessionDir(ctx, root, id) {
  const persistence = svc(ctx, "sessionPersistence");
  let header;
  let handle;
  try {
    handle = await persistence?.open(id, "read");
    header = handle?.header;
  } catch {
    /* 会话可能已不存在，或后端不可用 */
  }
  try {
    await handle?.close();
  } catch {
    /* ignore */
  }
  if (header === undefined) {
    const live = svc(ctx, "sessions")?.get(id);
    if (live !== undefined) header = live.header;
  }
  if (header !== undefined) {
    if (typeof persistence?.locate === "function") {
      try {
        const location = persistence.locate(header);
        if (location && typeof location.path === "string" && location.path.length > 0) {
          const dir = dirname(location.path);
          if (await dirExists(dir) && (await headerOfDir(dir))?.id === id) return dir;
        }
      } catch {
        /* 回退到编码路径 */
      }
    }
    if (header.cwd !== undefined) {
      const dir = join(root, projectKey(header.cwd), encodeSegment(id));
      if (await dirExists(dir) && (await headerOfDir(dir))?.id === id) return dir;
    }
  }
  const seg = encodeSegment(id);
  let frontier = [root];
  for (let depth = 0; depth < 3 && frontier.length > 0; depth++) {
    const next = [];
    for (const dir of frontier) {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === seg) {
          const candidate = join(dir, entry.name);
          try {
            const files = await fsp.readdir(candidate);
            if (files.some((f) => LOG_FILE_PATTERN.test(f)) && (await headerOfDir(candidate))?.id === id) return candidate;
          } catch {
            /* ignore */
          }
        } else if (depth < 2) {
          next.push(join(dir, entry.name));
        }
      }
    }
    frontier = next;
  }
  return undefined;
}

/** 会话目录里所有日志文件（可能同时存在 .zstd 与明文两个 generation）。 */
async function sessionLogFiles(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return [];
  }
  return entries.filter((f) => LOG_FILE_PATTERN.test(f)).map((f) => join(dir, f));
}

/* ------------------------------------------------------------------ */
/* 投影缓存作废                                                        */
/* ------------------------------------------------------------------ */

/**
 * 删除 session_projcache 域中该会话的记录。
 * 策略（借鉴 @michengai/dsh-archive-manager，按运行时版本自适应）：
 *  1. 新版宿主：sessionProjectionCache 服务自身的 delete()/whenIdle()；
 *  2. 当前宿主：在线打开的存储域 table("sessions").delete()（内存 + 磁盘同步）；
 *  3. 回退：直接删除磁盘上的 per-record JSON 文件。
 */
async function invalidateProjCache(ctx, id, projcacheRoot) {
  const cacheService = svc(ctx, "sessionProjectionCache");
  if (cacheService !== undefined && typeof cacheService.delete === "function") {
    try {
      await cacheService.whenIdle?.();
      await cacheService.delete(id);
      await cacheService.whenIdle?.();
      return "service";
    } catch (error) {
      ctx.logger?.debug?.(`dsh-session-cleaner: projection-cache service delete failed: ${messageOf(error)}`);
    }
  }
  const storageDomain = svc(ctx, "storageDomain");
  const domain = storageDomain?.get("session_projcache");
  if (domain) {
    try {
      const table = domain.table("sessions");
      if (typeof table?.delete === "function") {
        await table.delete(id);
        return "domain";
      }
    } catch (error) {
      ctx.logger?.debug?.(`dsh-session-cleaner: domain cache delete failed: ${messageOf(error)}`);
    }
  }
  const file = join(projcacheRoot, "sessions", `${id}.json`);
  try {
    await fsp.rm(file, { force: true });
    return "file";
  } catch {
    return "skipped";
  }
}

/* ------------------------------------------------------------------ */
/* 核心操作：删除整段会话                                              */
/* ------------------------------------------------------------------ */

async function detachLiveSession(ctx, id) {
  const store = svc(ctx, "sessions");
  const live = store?.get(id);
  if (live === undefined) return { detached: false };
  if (typeof store.flush === "function") {
    try {
      await store.flush(live);
    } catch {
      /* flush 失败不阻断删除 */
    }
  }
  if (typeof store.liveEntryFor !== "function" || typeof store.detachEntered !== "function") {
    throw new Error(`会话 ${id} 正在运行，且当前宿主版本不支持安全卸载；请先关闭它的标签页。`);
  }
  const entry = store.liveEntryFor(live);
  if (entry === undefined) {
    throw new Error(`会话 ${id} 的实时条目不存在；请关闭标签页后重试。`);
  }
  store.detachEntered(entry);
  return { detached: true };
}

/** 收集该会话的 subagent 子会话（fork 分支携带 parentSession 但 origin 不同，绝不级联）。 */
async function collectSubagentChildren(ctx, id) {
  const ids = new Set();
  const store = svc(ctx, "sessions");
  for (const session of store?.list() ?? []) {
    const header = session?.header;
    if (header?.parentSession === id && header.origin === "subagent" && typeof session.id === "string") {
      ids.add(session.id);
    }
  }
  try {
    for (const snapshot of (await svc(ctx, "sessionPersistence")?.list()) ?? []) {
      const header = snapshot?.header;
      if (header?.parentSession === id && header.origin === "subagent" && typeof header.id === "string") {
        ids.add(header.id);
      }
    }
  } catch {
    /* 枚举失败不阻断主删除 */
  }
  return [...ids];
}

/** 尽力而为：清理该会话作用域的 spill 目录（<root>/session-<sha256(id)[:12]>）。 */
async function cleanSpill(ctx, id) {
  try {
    const spill = svc(ctx, "spillStore");
    if (spill === undefined || typeof spill.root !== "string" || spill.root.length === 0) return;
    const dir = join(spill.root, `session-${createHash("sha256").update(id).digest("hex").slice(0, 12)}`);
    await fsp.rm(dir, { recursive: true, force: true });
  } catch {
    /* 尽力而为 */
  }
}

/** 通知全部客户端：该会话已离开实时/持久化目录（侧栏与列表即时刷新）。 */
function notifyRemoved(ctx, id) {
  try {
    ctx.emit("api-session/removed", id);
  } catch (error) {
    ctx.logger?.warn?.(`dsh-session-cleaner: removal notification for "${id}" failed: ${messageOf(error)}`);
  }
}

async function deleteWholeSession(ctx, id, sessionsRoot, projcacheRoot, options = {}) {
  const { requireVerifiedDir = false } = options;
  const live = await detachLiveSession(ctx, id);
  const registry = svc(ctx, "workspaceRegistry");
  let detached = false;
  if (registry) {
    for (const workspace of registry.list()) {
      if (workspace.sessionIds.includes(id)) {
        await workspace.detachSession(id);
        detached = true;
        break;
      }
    }
    await registry.unarchiveSession(id).catch(() => {});
    await registry.unpinSession(id).catch(() => {});
  }
  const cache = await invalidateProjCache(ctx, id, projcacheRoot);
  const dir = await findSessionDir(ctx, sessionsRoot, id);
  const cascaded = [];
  if (dir === undefined) {
    // 要求身份核实时，找不到目录就是硬失败——绝不静默报成功，也绝不猜别的目录。
    if (requireVerifiedDir) throw new Error(`会话 ${id} 的目录不存在（已核实身份仍未找到），拒绝删除`);
    // 未知会话：清掉残留痕迹后仍算成功（与 archive-manager 的 cleanupUnknown 一致）
    await cleanSpill(ctx, id);
    notifyRemoved(ctx, id);
    return { detached, cache, dir: null, live: live.detached, cascaded };
  }
  await fsp.rm(dir, { recursive: true, force: true });
  await cleanSpill(ctx, id);
  notifyRemoved(ctx, id);
  // 级联删除 subagent 子会话（各自递归处理自己的孙级）
  for (const childId of await collectSubagentChildren(ctx, id)) {
    try {
      await deleteWholeSession(ctx, childId, sessionsRoot, projcacheRoot);
      cascaded.push(childId);
    } catch (error) {
      ctx.logger?.warn?.(`dsh-session-cleaner: cascade delete of subagent child "${childId}" failed: ${messageOf(error)}`);
    }
  }
  return { detached, cache, dir, live: live.detached, cascaded };
}

/**
 * 校验 childId 确为 parentId 的直接 subagent 子会话，返回其 header；否则抛错。
 * 这是「删子智能体/停子智能体」的安全闸门：杜绝 childId===parentId 或张冠李戴。
 * 判据用官方 childSessionMeta() 写入的 header.parentSession + header.origin。
 */
async function assertDirectSubagent(ctx, sessionsRoot, parentId, childId) {
  if (childId === parentId) throw new Error("拒绝：childId 与 parentId 相同，不能把当前会话当子会话操作");
  let header;
  try {
    header = (await svc(ctx, "sessionPersistence")?.stat?.(childId))?.header;
  } catch {
    /* ignore */
  }
  if (header === undefined) header = svc(ctx, "sessions")?.get(childId)?.header;
  if (header === undefined) {
    const dir = await findSessionDir(ctx, sessionsRoot, childId);
    header = dir === undefined ? undefined : await headerOfDir(dir);
  }
  if (header === undefined) throw new Error(`子会话 ${childId} 不存在，已拒绝操作`);
  if (header.parentSession !== parentId || header.origin !== "subagent") {
    throw new Error(
      `拒绝：${childId} 不是 ${parentId} 的直接子会话（parentSession=${header.parentSession ?? "无"}，origin=${header.origin ?? "无"}）`,
    );
  }
  return header;
}

/** 刷新某个活跃会话（把挂起事件写盘），为后续日志改写做准备。 */
async function flushSession(ctx, id) {
  const store = svc(ctx, "sessions");
  const live = store?.get(id);
  if (live === undefined) return;
  if (typeof store.flush === "function") {
    try {
      await store.flush(live);
    } catch {
      /* ignore */
    }
  }
}

/**
 * 从父会话日志里移除指定子智能体的 `subagent/catalog` 条目。
 * 解码 → 过滤掉对应 childId 的 catalog 事件 → 重编码 → 原子写回 → 作废投影缓存。
 * 由于目录投影是追加式、无官方移除 API，这是唯一能真正让子智能体从目录消失的手段。
 */
async function removeSubagentCatalogEntry(ctx, parentId, childId, sessionsRoot, projcacheRoot) {
  await flushSession(ctx, parentId);
  const dir = await findSessionDir(ctx, sessionsRoot, parentId);
  if (dir === undefined) return 0;
  const files = await sessionLogFiles(dir);
  let removed = 0;
  for (const file of files) {
    try {
      const buffer = await fsp.readFile(file);
      const lines = decodeSessionLog(buffer);
      const filtered = [];
      let changed = false;
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === "subagent/catalog" && event.data?.childId === childId) {
            changed = true;
            continue;
          }
        } catch {
          /* 非 JSON 行保留 */
        }
        filtered.push(line);
      }
      if (!changed) continue;
      await atomicWrite(file, encodeSessionLog(filtered, true));
      removed += 1;
    } catch (error) {
      ctx.logger?.warn?.(`dsh-session-cleaner: remove catalog entry for "${childId}" from "${file}" failed: ${messageOf(error)}`);
    }
  }
  if (removed > 0) await invalidateProjCache(ctx, parentId, projcacheRoot).catch(() => {});
  return removed;
}

/* ------------------------------------------------------------------ */
/* HTTP 辅助                                                            */
/* ------------------------------------------------------------------ */

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": String(body.length) });
  res.end(body);
}

/* 持有的一次性子 agent run（childId -> run）。不主动 dispose，让子会话保持可 follow；
 * 关页时由 /delete-session 先 dispose run 再物理删除会话。 */
const childRuns = new Map();
/* 每个父会话唯一的「ask」子智能体 id（parentId -> childId）。优先复用它，不再每问一次新建一个。 */
const askChildren = new Map();
/* ask 子智能体 id 的集合，供 agent/pre-step 的"作用域内自动压缩"做 O(1) 判定。 */
const askChildIds = new Set();
/* ask 子智能体的固定名字（目录里显示的名字）。 */
const ASK_LABEL = "ask";
/* 旧版本用过的前缀；复用时会一并认领，避免历史遗留的继续型 ask 子会话被重复新建。 */
const ASK_LABEL_LEGACY = "dsh-session-cleaner:ask";
/* 未过期的信号：投递只需要"没有被取消"，不需要由我们持有取消权。 */
const deliverySignal = () => new AbortController().signal;

/**
 * 找出该父会话下**可复用**的 ask 子会话 id。
 * 只认 mode === "continuable"（一次性子会话无法再投递）。优先官方 listChildren（读父目录投影，
 * 不加载子 agent，且宿主重启后依然能找到）；该服务不可用或读取失败时才回退到本次进程的内存记录。
 * @returns childId，找不到返回 undefined。
 */
async function findReusableAskChild(ctx, parentId) {
  const subagents = svc(ctx, "subagents");
  const isAskEntry = (entry) =>
    entry !== null &&
    typeof entry === "object" &&
    entry.mode === "continuable" &&
    typeof entry.id === "string" &&
    (entry.label === ASK_LABEL || (typeof entry.label === "string" && entry.label.startsWith(ASK_LABEL_LEGACY)));
  try {
    const entries = await subagents?.listChildren?.(parentId);
    if (Array.isArray(entries)) {
      const candidates = entries.filter(isAskEntry);
      if (candidates.length === 0) return undefined; // 目录可读且明确没有 → 不信内存猜测
      candidates.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
      return candidates[0].id;
    }
  } catch (error) {
    ctx.logger?.debug?.(`dsh-session-cleaner: ask-child lookup failed, falling back to in-memory record: ${messageOf(error)}`);
  }
  const remembered = askChildren.get(parentId);
  return typeof remembered === "string" && remembered.length > 0 ? remembered : undefined;
}

/* ------------------------------------------------------------------ */
/* 插件入口                                                            */
/* ------------------------------------------------------------------ */

function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) };
  const sessionsRoot = config.sessionsRoot && config.sessionsRoot.length > 0 ? config.sessionsRoot : join(dshHome(), "sessions");
  const projcacheRoot =
    config.projcacheRoot && config.projcacheRoot.length > 0
      ? config.projcacheRoot
      : join(dshHome(), "storages", "session_projcache");

  const webServer = svc(ctx, "webServer");

  if (webServer && config.enableHttpApi) {
    ctx.effect(() => {
      const disposers = [
        webServer.register({
          kind: "exact",
          path: "/api/dsh-session-cleaner/version",
          handler: (req, res) => {
            // 用于确认"当前跑的是哪一版代码"（插件热重载是否真的生效）。
            sendJson(res, 200, { ok: true, name: "dsh-session-cleaner", build: PLUGIN_BUILD, features: PLUGIN_FEATURES });
          },
        }),
        webServer.register({
          kind: "exact",
          path: "/api/dsh-session-cleaner/ask",
          handler: async (req, res) => {
            try {
              const body = await readJsonBody(req);
              const id = body.sessionId;
              const text = body.text;
              if (typeof id !== "string" || id.length === 0) return sendJson(res, 400, { ok: false, summary: "缺少 sessionId" });
              if (typeof text !== "string" || text.length === 0) return sendJson(res, 400, { ok: false, summary: "缺少 text" });
              const captain = ctx.get("agents")?.get(id);
              if (captain === undefined) return sendJson(res, 400, { ok: false, summary: "找不到当前会话的 agent" });
              const subagents = ctx.get("subagents");
              if (subagents === undefined || typeof subagents.startContinuable !== "function") {
                return sendJson(res, 500, { ok: false, summary: "subagents 服务不可用（缺少 subagent 后端）" });
              }
              const content = [{ type: "text", text }];

              // 1) 优先复用已有的 ask 子智能体：先看内存记录（快），再查官方目录（宿主重启后也能找回）。
              const candidates = [];
              const remembered = askChildren.get(id);
              if (typeof remembered === "string" && remembered.length > 0) candidates.push(remembered);
              const discovered = await findReusableAskChild(ctx, id);
              if (discovered !== undefined && !candidates.includes(discovered)) candidates.push(discovered);
              if (typeof subagents.sendMessage === "function") {
                for (const childId of candidates) {
                  try {
                    // sendMessage：目标空闲则开新一轮，正在跑则并进当前轮；不新建子会话。
                    await subagents.sendMessage(captain, childId, content, { signal: deliverySignal() });
                    askChildren.set(id, childId);
                    askChildIds.add(childId);
                    return sendJson(res, 200, { ok: true, childId, mode: "reused" });
                  } catch (error) {
                    ctx.logger?.warn?.(
                      `dsh-session-cleaner: reusing ask child "${childId}" failed, creating a new one: ${messageOf(error)}`,
                    );
                    if (askChildren.get(id) === childId) askChildren.delete(id);
                    askChildIds.delete(childId);
                  }
                }
              }

              // 2) 否则创建**唯一**名为 ask 的可继续子 agent；回答结束即空闲，不再消耗 token。
              const start = await subagents.startContinuable({
                provider: "spawn",
                label: ASK_LABEL,
                request: {
                  prompt: content,
                  parent: captain,
                },
                signal: new AbortController().signal,
              });
              askChildren.set(id, start.childId);
              askChildIds.add(start.childId);
              sendJson(res, 200, { ok: true, childId: start.childId, mode: "created" });
            } catch (error) {
              sendJson(res, 500, { ok: false, summary: messageOf(error) });
            }
          },
        }),
        webServer.register({
          kind: "exact",
          path: "/api/dsh-session-cleaner/terminate-children",
          handler: async (req, res) => {
            try {
              const body = await readJsonBody(req);
              const id = body.sessionId;
              if (typeof id !== "string" || id.length === 0) return sendJson(res, 400, { ok: false, summary: "缺少 sessionId" });
              const captain = ctx.get("agents")?.get(id);
              if (captain === undefined) return sendJson(res, 400, { ok: false, summary: "找不到当前会话的 agent" });
              const subagents = ctx.get("subagents");
              if (subagents !== undefined && typeof subagents.drainContinuableDescendants === "function") {
                await subagents.drainContinuableDescendants([captain]).catch(() => {});
              }
              // 删除所有遗留的（持久化）子会话，让其从会话列表消失。
              const children = await collectSubagentChildren(ctx, id);
              let deleted = 0;
              for (const childId of children) {
                try {
                  await deleteWholeSession(ctx, childId, sessionsRoot, projcacheRoot);
                  deleted += 1;
                } catch (error) {
                  ctx.logger?.warn?.(`dsh-session-cleaner: terminate child "${childId}" failed: ${messageOf(error)}`);
                }
              }
              sendJson(res, 200, { ok: true, summary: `已终结并删除 ${deleted} 个子 agent`, deleted });
            } catch (error) {
              sendJson(res, 500, { ok: false, summary: messageOf(error) });
            }
          },
        }),
        webServer.register({
          kind: "exact",
          path: "/api/dsh-session-cleaner/delete-session",
          handler: async (req, res) => {
            try {
              const body = await readJsonBody(req);
              const id = body.sessionId;
              if (typeof id !== "string" || id.length === 0) return sendJson(res, 400, { ok: false, summary: "缺少 sessionId" });
              // 若是一次性子 agent，先 dispose 其 run（释放 agent），再物理删除会话。
              const run = childRuns.get(id);
              if (run) {
                childRuns.delete(id);
                try {
                  run.dispose?.();
                } catch {
                  /* ignore */
                }
              }
              const result = await deleteWholeSession(ctx, id, sessionsRoot, projcacheRoot);
              const extra = [];
              if (result.live) extra.push("已停止该会话");
              if (result.cascaded.length > 0) extra.push(`级联删除 ${result.cascaded.length} 个子会话`);
              sendJson(res, 200, {
                ok: true,
                summary: `已删除会话 ${id}${extra.length > 0 ? `（${extra.join("；")}）` : ""}。`,
                cascaded: result.cascaded,
              });
            } catch (error) {
              sendJson(res, 500, { ok: false, summary: messageOf(error) });
            }
          },
        }),
        webServer.register({
          kind: "exact",
          path: "/api/dsh-session-cleaner/delete-subagent",
          handler: async (req, res) => {
            try {
              const body = await readJsonBody(req);
              const childId = body.childId;
              const parentId = body.parentId;
              if (typeof childId !== "string" || childId.length === 0) return sendJson(res, 400, { ok: false, summary: "缺少 childId" });
              if (typeof parentId !== "string" || parentId.length === 0) return sendJson(res, 400, { ok: false, summary: "缺少 parentId" });
              // 安全闸门：childId 必须是 parentId 的直接 subagent 子会话（杜绝 childId===parentId 整段误删）。
              try {
                await assertDirectSubagent(ctx, sessionsRoot, parentId, childId);
              } catch (error) {
                return sendJson(res, 400, { ok: false, summary: messageOf(error) });
              }
              const subagents = ctx.get("subagents");
              // 1. 打断 + 释放 continuable 激活（父在线则 drain，否则走官方 remote 中断）。
              const parent = ctx.get("agents")?.get(parentId);
              if (parent !== undefined && subagents && typeof subagents.drainContinuableChildren === "function") {
                await subagents.drainContinuableChildren(parent, [childId]).catch(() => {});
              } else if (subagents && typeof subagents.interruptByParent === "function") {
                subagents.interruptByParent(childId, parentId, "continuable");
              }
              // 2. 删除子会话（物理 + 列表 + 投影缓存）；目录必须已核实身份，找不到即拒绝。
              await deleteWholeSession(ctx, childId, sessionsRoot, projcacheRoot, { requireVerifiedDir: true });
              // 3. 改写父日志移除 catalog 行——默认关闭（与官方 append-only 契约冲突、有截断风险）。
              let catalogRemoved = 0;
              if (config.rewriteParentLog) {
                catalogRemoved = await removeSubagentCatalogEntry(ctx, parentId, childId, sessionsRoot, projcacheRoot);
              }
              sendJson(res, 200, {
                ok: true,
                summary: `已删除子智能体 ${childId}${catalogRemoved > 0 ? `（已从目录移除，重启后生效）` : ""}`,
                catalogRemoved,
              });
            } catch (error) {
              sendJson(res, 500, { ok: false, summary: messageOf(error) });
            }
          },
        }),
      ];
      return () => disposers.forEach((dispose) => dispose?.());
    }, "dsh-session-cleaner: http");
  }

  /**
   * ask 子智能体的**作用域内自动压缩**。
   *
   * 为什么只能在这里做：官方 `compactNow()` 的契约要求一个"活的空闲 Agent"
   * (`ManualCompactAgentContext` 必须提供 `runMaintenance()`)，而可继续子会话在 settle 之后
   * 就不再驻留（`agents.get()` 变 undefined），所以"答完之后手动压缩"没有官方入口。
   * 只有在**轮次打开、agent 活着**的 pre-step 才压得动——官方 compaction-basic 的自动压缩
   * 用的就是同一个接缝（`ctx.on("agent/pre-step", … await compactIfNeeded(agent,"pressure",signal))`）。
   *
   * 作用域：只对本插件正在复用的 ask 子会话生效（不是全局自动压缩）。
   * 失败绝不打断轮次：吞掉错误并照常 `next()`（与官方同一策略）。
   */
  if (config.askAutoCompact) {
    ctx.effect(() => {
      const stop = ctx.on("agent/pre-step", async (payload, next) => {
        const agent = payload?.agent;
        const signal = payload?.signal;
        try {
          if (agent !== undefined && askChildIds.has(agent.id) && signal !== undefined && !signal.aborted) {
            const compaction = svc(ctx, "compaction");
            if (compaction !== undefined && typeof compaction.compactIfNeeded === "function") {
              const result = await compaction.compactIfNeeded(agent, "pressure", signal);
              if (result !== null && result !== undefined) {
                const items = Array.isArray(result.shadowedSeqs) ? result.shadowedSeqs.length : 0;
                const tokens = typeof result.shadowedTokenCount === "number" ? result.shadowedTokenCount : 0;
                ctx.logger?.info?.(
                  `dsh-session-cleaner: ask 子智能体自动压缩了 ${items} 项历史（约 ${tokens} tokens）`,
                );
              }
            }
          }
        } catch (error) {
          ctx.logger?.warn?.(`dsh-session-cleaner: ask 自动压缩失败，继续本轮：${messageOf(error)}`);
        }
        return next();
      });
      return () => stop?.();
    }, "dsh-session-cleaner: ask auto-compaction");
  }
}

export { apply };

/* 供测试导入的纯函数 */
export const internals = {
  encodeSegment,
  projectKey,
  scanZstdFrames,
  decodeSessionLog,
  encodeSessionLog,
};
