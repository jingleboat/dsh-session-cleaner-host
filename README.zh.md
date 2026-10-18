# dsh-session-cleaner

一个 **DeepSeek Harness（DSH）** 插件——宿主半边与 Web 客户端半边同一个 bundle——给 DSH Web GUI 加两件事：

1. **删除整个会话**：侧栏会话行菜单里，带确认对话框。
2. **划词右键引用 / 提问**：在聊天里划选一段文字后**右键**——插件接管右键菜单，弹出
   **复制 / 引用 / 提问**，其中「复制」排第一，位置就是原来系统菜单项的位置：
   - **复制**：把选中文本写入剪贴板（与原系统菜单同一个动作，只是改由插件绘制）；
   - **引用**：把带来源元数据（角色 + 回合）的 Markdown 引用块插入输入框；
   - **提问**：把选中内容 + 你的问题交给一个**并发子智能体**，答案流式显示在右侧栏，不打断主对话。

[English](README.md)

---

## 功能

| 槽位 | 作用 |
| --- | --- |
| `sidebar.workspaces.session.menu.item` | **删除会话**：运行中的会话先 flush + detach → 从工作区登记摘除 → 作废投影缓存 → 物理删除会话目录 → 清理 spill → 级联删除 `origin: subagent` 的子会话（**fork 分支绝不级联**）→ 广播 `api-session/removed`。 |
| `shell.overlay` | 划词**右键菜单**：**复制**（剪贴板）/ **引用**（插入输入框）/ **提问**（并发子智能体提问）。菜单由插件自绘——桌面端的原生右键菜单是 Electron 主进程用 `Menu.buildFromTemplate` 弹的，渲染进程插件无法往里加条目；在 `contextmenu` 里 `preventDefault()` 就不会请求主进程弹菜单。 |
| `sidebar.right.pane.tab` | **追问** tab：在右侧栏流式显示该 ask 子智能体的回答（reasoning + text）。 |

### 提问只复用同一个子智能体

不是每问一次就新建。每个父会话只保留**一个**可继续子智能体，label 固定为 `ask`；后续提问通过官方
`subagents.listChildren()` 目录找回并投递给它（所以宿主重启后依然能复用）。

### ask 子智能体的作用域内自动压缩

复用会让 `ask` 子智能体的上下文越积越大，因此宿主自己注册了一个 `agent/pre-step` 监听，
**只对本插件的 ask 子智能体**调用 `ctx.compaction.compactIfNeeded(agent, "pressure", signal)`。
全局自动压缩保持关闭（`compaction-basic` 以 `auto: false` 挂载），**主会话不受影响**。

---

## 安装

插件是普通 DSH bundle。在 profile 的 `package.json` 里加：

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

包名必须在**三处保持一致**：`package.json` 的 `name`、`client.js` 里
`window.__ModuleLoader__.load({ id: "…" })`、以及 profile 的 `dsh.profile.bundles` 条目。

然后在 profile 的补丁层（`~/.dsh/profiles/<profile>/cordis.patch.yml`，它在**每个 bundle 层之后**应用）加上压缩后端：

```yaml
- id: compaction-basic
  name: "@deepseek-ai/dsh-compaction-basic"
  disabled: false
  config:
    auto: false
```

> 这一行属于 **profile 补丁**，不要写进本包的 bundle 补丁：装一个插件不应该悄悄替整个 profile 打开另一个包。

改过宿主代码后需要重启 DSH，然后刷新页面。确认当前生效的是哪一版：

```bash
curl -s http://127.0.0.1:19387/api/dsh-session-cleaner/version
```

---

## 用法

**引用 / 提问**：在聊天里划选文字 → 在选区内**右键** → 菜单出现「复制 / 引用 / 提问」（复制在最上，
下面一条分隔线）→ 点「引用」插入引用块，或点「提问」把菜单换成问题输入框，发送后右侧栏自动打开
「追问」tab 并流式显示回答。

在输入框里右键、以及没有选区时右键，仍然是系统菜单（剪切 / 粘贴 / 全选）。

**删除会话**：侧栏会话行 → `⋯` → **删除会话**。删除当前打开的会话会先停止它，并把页面切到新会话。

---

## HTTP API

| 方法 | 路径 | 请求体 | 用途 |
| --- | --- | --- | --- |
| `GET` | `/api/dsh-session-cleaner/version` | — | 当前生效的构建标记（诊断用）。 |
| `POST` | `/api/dsh-session-cleaner/ask` | `{ sessionId, text }` | 把问题投递给复用的 `ask` 子智能体；首次不存在时创建。 |
| `POST` | `/api/dsh-session-cleaner/delete-session` | `{ sessionId }` | 删除整个会话（并级联其子智能体子会话）。 |
| `POST` | `/api/dsh-session-cleaner/delete-subagent` | `{ childId, parentId }` | 删除一个直接子智能体会话；有血缘闸门。 |
| `POST` | `/api/dsh-session-cleaner/terminate-children` | `{ sessionId }` | 排空某会话的全部可继续后代。 |

---

## 设计约束（都是踩过坑换来的）

1. **DSH 没有"删除会话"的 API。** `sessions` / `sessionPersistence` / `sessionProjectionCache` /
   `sessionController` 全是追加式；持久化 seam 的文档原话是 *"Nothing deletes session files … the seam
   has no deletion API."* 所以本插件做的是**有意的磁盘手术**——因此配了严格的身份校验。
2. **绝不改写别的会话的日志。** 早期版本会改写父会话日志来抹掉一行 `subagent/catalog`。日志是追加式的，
   宿主可能正在并发写入，于是"读 → 过滤 → 原子 rename"有可能把整段对话截断。`rewriteParentLog`
   现在默认 **`false`**。
3. **会话目录查找是身份校验式的。** 任何候选目录都必须能读到 `header.id` 等于目标 id 的日志；**绝不猜目录**。
4. **`subagent/catalog` 只能追加。** 没有官方移除某一行的办法；删了子会话却留着目录行会产生"打不开的悬空行"。
   本插件不碰目录行。
5. **子智能体操作有血缘闸门。** `delete-subagent` 要求
   `header.parentSession === parentId && header.origin === "subagent"`，并拒绝 `childId === parentId`
   ——少了这条，所谓"删除子智能体"会删掉你正在看的这个会话。
6. **压缩需要"活的空闲 Agent"。** `compaction.compactNow(agent, signal)` 要的是
   `ManualCompactAgentContext`（必须有 `runMaintenance()`），而可继续子智能体**一轮答完就不再驻留**。
   因此"答完之后手动压缩"没有受支持的入口；只有 `agent/pre-step`（轮次打开、agent 活着）才压得动
   ——这就是本插件挂 `agent/pre-step` 而不是给一个按钮的原因。
7. **刻意自包含。** 宿主半边**只用 Node 内置模块**，不依赖任何 `@deepseek-ai/*` 运行时包，
   以免在 profile 的 `node_modules` 里遮蔽官方包；`package.json` 没有任何 dependencies。
8. **划词按原文引用**，上限 2000 字符；跨两条消息、或落在流式输出中的选区会被忽略。

---

## 测试

```powershell
npm test
```

两套自包含测试，不依赖 DSH、浏览器或真实会话数据：

| 文件 | 覆盖内容 |
| --- | --- |
| `test/internals.test.mjs` | 宿主半边：zstd 会话日志分帧、投影键、日志解码/编码 |
| `test/client-context-menu.test.mjs` | 客户端半边：用最小 DOM/React/ctx 桩加载**真实** `client.js`，验证右键链路——捕获阶段监听、只在"选中消息"时 `preventDefault()`、菜单顺序（复制 → 引用 → 提问）、视口钳制、输入框/无选区时放行系统菜单、dispose 后监听摘除 |

`test/verify-served-bundle.mjs` 是可选的活体检查（需要 DSH 在跑）：它按 `client.js` 的元数据重算
宿主 bundle 的 rev，拉取宿主正在下发的那一份，如果仍在发旧副本就以非零退出码失败。用 `DSH_WEB_URL`
可以指向别的实例。

---

## 兼容性

针对 **DSH `0.2.0-rc.2`**（桌面/Web profile：`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`）
开发与测试。只使用公开 seam：`slots`、`locale`、`sessions`、`subagents`、`agents`、
`sessionPersistence`、`sessionProjectionCache`、`workspaceRegistry`、`spillStore`、`compaction`；
可选服务缺失时降级而非报错。

---

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
