/**
 * Self-contained smoke tests for the client half (test/client-context-menu.test.mjs).
 *
 * No browser and no network: a minimal DOM / React / Cordis-ctx stub lets us
 * load client.js through its real __ModuleLoader__ entry, run apply(), then
 * drive the right-click path and inspect the menu tree it renders.
 *
 * Run: node test/client-context-menu.test.mjs
 */
import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    const detail = fn();
    passed += 1;
    console.log(`PASS  ${name}${detail === undefined ? "" : `  -- ${detail}`}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/* ------------------------------------------------------------------ */
/* stubs                                                              */
/* ------------------------------------------------------------------ */

/** Every document listener the plugin installs, keyed by type. */
const documentListeners = [];
function makeDocument() {
  const styleEl = () => ({ dataset: {}, style: {}, textContent: "", remove() {} });
  return {
    querySelector: () => null,
    createElement: () => styleEl(),
    head: { appendChild() {} },
    body: { appendChild() {} },
    addEventListener(type, fn, opts) {
      documentListeners.push({ type, fn, capture: opts === true || opts?.capture === true });
    },
    removeEventListener(type, fn) {
      const index = documentListeners.findIndex((entry) => entry.type === type && entry.fn === fn);
      if (index >= 0) documentListeners.splice(index, 1);
    },
  };
}

function listenerFor(type) {
  const entry = documentListeners.find((candidate) => candidate.type === type);
  return entry === undefined ? undefined : entry;
}

/** Fake event object: enough of MouseEvent for the handler. */
function makeContextMenuEvent(target, { x = 100, y = 200 } = {}) {
  const event = {
    target,
    clientX: x,
    clientY: y,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
  };
  return event;
}

function makeAnchor(key, { kind = "assistant", turn = "3" } = {}) {
  const anchor = {
    dataset: { chatFlowKind: kind, chatTurn: turn, chatAnchorKey: key },
    hasAttribute: () => false,
    querySelector: () => null,
  };
  return anchor;
}

/** An element inside a chat message: closest() resolves its own anchor. */
function makeMessageTarget(anchor) {
  return {
    nodeType: 1,
    tagName: "DIV",
    closest: (selector) => (selector === "[data-chat-anchor-key]" ? anchor : null),
  };
}

/** A textarea-like target: the plugin must leave the native menu alone. */
function makeEditableTarget() {
  return {
    nodeType: 1,
    tagName: "TEXTAREA",
    closest: () => null,
  };
}

/** Selection stub; `node` doubles as range container and anchor owner. */
function makeSelection(text, node) {
  return {
    isCollapsed: false,
    rangeCount: 1,
    toString: () => text,
    getRangeAt: () => ({
      startContainer: node,
      endContainer: node,
      getBoundingClientRect: () => ({ left: 10, top: 10, width: 40, height: 16, bottom: 26 }),
    }),
  };
}

const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value ?? null }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
};

/** Locale table captured from ctx.locale.register. */
const locales = new Map();

/** Slot registrations captured from ctx.slots.register. */
const slots = [];

/** Labels recorded by ctx.effect, mapped to the disposer the callback returned. */
const effects = new Map();

function makeCtx() {
  const ctx = {
    effect(fn, label) {
      const dispose = fn();
      effects.set(label, dispose);
      return dispose;
    },
    locale: {
      register(ns, dict) {
        locales.set(ns, dict);
        return () => {};
      },
      bind: (ns) => (key, params) => {
        const registered = locales.get(ns) ?? {};
        // ctx.locale.register receives { zh, en }; bind() picks the active language.
        const dict = registered.zh ?? registered.en ?? registered;
        const template = dict[key] ?? key;
        if (params === undefined) return template;
        return template.replace(/\{(\w+)\}/g, (_match, name) => String(params[name] ?? ""));
      },
    },
    slots: {
      inject(name, register) {
        register();
        return () => {};
      },
      register(definition, component) {
        slots.push({ definition, component });
        return () => {};
      },
    },
    get: () => undefined,
    sessions: { list: { getSnapshot: () => ({ ids: [], byId: {} }) } },
    workspaces: { list: { getSnapshot: () => ({ items: [] }) } },
    uiWorkspace: {},
    remote: { session: {} },
  };
  return ctx;
}

/* ------------------------------------------------------------------ */
/* load the real client module                                        */
/* ------------------------------------------------------------------ */

const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
assert(source.includes("__ModuleLoader__"), "client.js must register through the DSH module loader");

let loaded;
globalThis.window = {
  __ModuleLoader__: { load(definition) { loaded = definition; } },
  getSelection: () => null,
  innerWidth: 1200,
  innerHeight: 800,
  addEventListener() {},
  removeEventListener() {},
  setTimeout: (fn) => { void fn; return 0; },
  clearTimeout: () => {},
};
globalThis.document = makeDocument();
// The plugin's module scope runs at import time, so the loader stub must exist first.
await import(new URL("../client.js", import.meta.url).href).catch((error) => {
  throw new Error(`client.js failed to evaluate: ${error instanceof Error ? error.message : String(error)}`);
});

check("client bundle registers itself with the module loader", () => {
  assert(loaded !== undefined, "window.__ModuleLoader__.load was not called");
  assertEqual(loaded.id, "@local/dsh-session-cleaner-host", "module id");
  return loaded.id;
});

const clientModule = loaded.factory((specifier) => {
  if (specifier === "react") return React;
  throw new Error(`unexpected require(${specifier})`);
});

const ctx = makeCtx();
clientModule.apply(ctx);

check("client half injects the services it needs", () => {
  const inject = clientModule.inject.join(",");
  assert(inject.includes("slots"), "slots");
  assert(inject.includes("locale"), "locale");
  assert(inject.includes("sessions"), "sessions");
  return inject;
});

check("slots include the right-click menu and the confirm dialog", () => {
  const ids = slots.map((entry) => entry.definition.id);
  assert(ids.includes("dsh-session-cleaner.selection-menu"), `missing selection-menu (got ${ids.join(", ")})`);
  assert(ids.includes("dsh-session-cleaner.confirm"), "missing confirm dialog");
  assert(!ids.includes("dsh-session-cleaner.selection-popover"), "the old floating toolbar slot must be gone");
  return ids.join(", ");
});

check("contextmenu listener is installed in the capture phase", () => {
  const listener = listenerFor("contextmenu");
  assert(listener !== undefined, "no contextmenu listener");
  assert(listener.capture, "listener must use the capture phase to beat the native menu");
  return "capture";
});

/** Render the registered menu component with the current store value. */
function renderMenu() {
  const entry = slots.find((candidate) => candidate.definition.id === "dsh-session-cleaner.selection-menu");
  assert(entry !== undefined, "selection menu slot is not registered");
  return entry.component();
}

function textOf(node) {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  return node.children.map(textOf).join(" ");
}

check("right-click on a selected message opens the custom menu", () => {
  const anchor = makeAnchor("anchor-1");
  const node = makeMessageTarget(anchor);
  globalThis.window.getSelection = () => makeSelection("hello world", node);
  const event = makeContextMenuEvent(node);
  listenerFor("contextmenu").fn(event);
  assert(event.defaultPrevented, "preventDefault() must run so the native menu does not pop");
  assert(event.propagationStopped, "stopPropagation() must run");
  const tree = renderMenu();
  assertEqual(tree.props.className, "dsc-ctxMenu", "menu root class");
  return "opened";
});

check("menu lists Copy first, then Quote and Ask", () => {
  const tree = renderMenu();
  const items = tree.children.filter((child) => child?.props?.className === "dsc-menuItem");
  assertEqual(items.length, 3, "three menu items");
  assert(textOf(items[0]).includes("复制"), `first item must be Copy, got: ${textOf(items[0])}`);
  assert(textOf(items[1]).includes("引用"), `second item must be Quote, got: ${textOf(items[1])}`);
  assert(textOf(items[2]).includes("提问"), `third item must be Ask, got: ${textOf(items[2])}`);
  // The separator sits between Copy and the plugin's own entries.
  const separatorIndex = tree.children.findIndex((child) => child?.props?.className === "dsc-ctxSep");
  assertEqual(separatorIndex, 1, "separator right after Copy");
  return "复制 / 引用 / 提问";
});

check("menu is clamped into the viewport", () => {
  const anchor = makeAnchor("anchor-2");
  const node = makeMessageTarget(anchor);
  globalThis.window.getSelection = () => makeSelection("clamp me", node);
  listenerFor("contextmenu").fn(makeContextMenuEvent(node, { x: 5000, y: 5000 }));
  const tree = renderMenu();
  assert(tree.props.style.left <= 1200, `left ${tree.props.style.left} must stay on screen`);
  assert(tree.props.style.top <= 800, `top ${tree.props.style.top} must stay on screen`);
  return `${tree.props.style.left},${tree.props.style.top}`;
});

check("right-click inside a textarea keeps the native menu", () => {
  const editable = makeEditableTarget();
  globalThis.window.getSelection = () => makeSelection("composer text", editable);
  const event = makeContextMenuEvent(editable);
  listenerFor("contextmenu").fn(event);
  assert(!event.defaultPrevented, "an editable target must not be intercepted");
  return "native kept";
});

check("right-click without a selection keeps the native menu", () => {
  const anchor = makeAnchor("anchor-3");
  const node = makeMessageTarget(anchor);
  globalThis.window.getSelection = () => ({ isCollapsed: true, rangeCount: 0, toString: () => "" });
  const event = makeContextMenuEvent(node);
  listenerFor("contextmenu").fn(event);
  assert(!event.defaultPrevented, "no selection means no interception");
  return "native kept";
});

check("right-click outside a message keeps the native menu", () => {
  const anchor = makeAnchor("anchor-4");
  const node = makeMessageTarget(anchor);
  globalThis.window.getSelection = () => makeSelection("somewhere else", node);
  const outside = { nodeType: 1, tagName: "DIV", closest: () => null };
  const event = makeContextMenuEvent(outside);
  listenerFor("contextmenu").fn(event);
  assert(!event.defaultPrevented, "a non-message target must not be intercepted");
  return "native kept";
});

check("disposing the plugin removes the contextmenu listener", () => {
  const dispose = effects.get("dsh-session-cleaner: context menu listener");
  assert(typeof dispose === "function", "the contextmenu effect must return a disposer");
  dispose();
  assert(listenerFor("contextmenu") === undefined, "listener still installed after dispose");
  return "removed";
});

/* ------------------------------------------------------------------ */

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exitCode = 1;
