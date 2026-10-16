/**
 * Self-contained tests for the pure internals of dsh-session-cleaner.
 *
 * Everything here is synthetic: the fixtures are built in memory and compressed
 * with node:zlib, so the suite needs no local paths and no real session data.
 *
 * Run: node test/internals.test.mjs   (or `npm test`)
 */
import { zstdCompressSync, constants as zlibConstants, zstdDecompressSync } from "node:zlib";
import { internals } from "../index.js";

const { encodeSegment, projectKey, scanZstdFrames, decodeSessionLog, encodeSessionLog } = internals;

const ZSTD_MAGIC = 0xfd2fb528;
const SESSION_ID = "session-11111111-2222-4333-8444-555555555555";

let passed = 0;
let failed = 0;

/** Run one assertion group and report it. */
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

/** Minimal but shape-faithful throwaway assertions. */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function assertEqual(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`);
}

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const header = {
  type: "session",
  version: 4,
  id: SESSION_ID,
  createdAt: 1_700_000_000_000,
  cwd: "C:\\work\\demo",
  isSeeded: false,
  delegationDepth: 0,
  agentPreset: "standard",
};
const headerLine = JSON.stringify(header);

/** `count` synthetic surface events, starting at `startSeq`. */
function eventLines(count, startSeq = 1) {
  const lines = [];
  for (let i = 0; i < count; i += 1) {
    const seq = startSeq + i;
    lines.push(
      JSON.stringify({
        type: "user/message",
        seq,
        time: 1_700_000_000_000 + seq,
        data: { role: "user", message: { role: "user", content: [{ type: "text", text: `message ${seq}` }] } },
        surfaceOp: "append",
      }),
    );
  }
  return lines;
}

/** One standalone zstd frame holding `lines` (optionally checksummed). */
function frameOf(lines, checksum) {
  const text = lines.join("\n") + (lines.length > 0 ? "\n" : "");
  const params =
    checksum && zlibConstants.ZSTD_c_checksumFlag !== undefined
      ? { params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 } }
      : {};
  return zstdCompressSync(Buffer.from(text, "utf8"), params);
}

/* ------------------------------------------------------------------ */
/* 1. path encoding                                                    */
/* ------------------------------------------------------------------ */

check("projectKey() maps a Windows cwd to the observed directory key", () => {
  const key = projectKey("C:\\work\\demo");
  assertEqual(key, "--C-work-demo--", "projectKey");
  return key;
});

check("projectKey() escapes non-ASCII characters as ~XXXX", () => {
  const key = projectKey("D:\\\u8D44\u6599");
  assertEqual(key, "--D-~8D44~6599--", "projectKey(non-ASCII)");
  return key;
});

check("projectKey() collapses separator runs", () => {
  assertEqual(projectKey("C:\\\\a//b"), "--C-a-b--", "collapsed");
  return projectKey("C:\\\\a//b");
});

check("encodeSegment() passes safe characters through", () => {
  assertEqual(encodeSegment("session-1_2.3-4"), "session-1_2.3-4", "safe");
  return encodeSegment(SESSION_ID);
});

check("encodeSegment() escapes dots, tildes and CJK", () => {
  assertEqual(encodeSegment("."), "~002E", "'.");
  assertEqual(encodeSegment(".."), "~002E~002E", "'..'");
  assertEqual(encodeSegment("~"), "~007E", "'~'");
  assertEqual(encodeSegment("\u65E5\u8BB0\u7BA1\u7406"), "~65E5~8BB0~7BA1~7406", "CJK");
  return encodeSegment("\u65E5\u8BB0\u7BA1\u7406");
});

/* ------------------------------------------------------------------ */
/* 2. zstd frame scanning and decoding                                 */
/* ------------------------------------------------------------------ */

check("scanZstdFrames() finds exactly one frame in a single-frame log", () => {
  const buffer = frameOf([headerLine, ...eventLines(20)], true);
  const frames = scanZstdFrames(buffer);
  assertEqual(frames.length, 1, "frame count");
  assertEqual(frames[0].start, 0, "first frame start");
  assertEqual(frames[0].end, buffer.length, "first frame end");
  return `bytes=${buffer.length}`;
});

check("decodeSessionLog() round-trips a checksummed single-frame log", () => {
  const lines = [headerLine, ...eventLines(50)];
  const decoded = decodeSessionLog(frameOf(lines, true));
  assertEqual(decoded, lines, "round-trip");
  return `lines=${decoded.length}`;
});

check("decodeSessionLog() concatenates multiple frames", () => {
  const first = [headerLine, ...eventLines(10, 1)];
  const second = eventLines(10, 11);
  const buffer = Buffer.concat([frameOf(first, true), frameOf(second, true)]);
  const decoded = decodeSessionLog(buffer);
  assertEqual(decoded, [...first, ...second], "multi-frame");
  return `frames=2 lines=${decoded.length}`;
});

check("decodeSessionLog() tolerates a torn tail frame", () => {
  const complete = [headerLine, ...eventLines(10, 1)];
  const torn = frameOf(eventLines(5, 11), true);
  const buffer = Buffer.concat([frameOf(complete, true), torn.subarray(0, torn.length - 7)]);
  const decoded = decodeSessionLog(buffer);
  assertEqual(decoded, complete, "torn tail dropped, complete frames kept");
  return `lines=${decoded.length} (dropped a torn frame)`;
});

check("decodeSessionLog() reads a plaintext (uncompressed) generation", () => {
  const lines = [headerLine, ...eventLines(3)];
  const decoded = decodeSessionLog(Buffer.from(lines.join("\n") + "\n", "utf8"));
  assertEqual(decoded, lines, "plaintext");
  return `lines=${decoded.length}`;
});

check("scanZstdFrames() rejects a frame with reserved header bits", () => {
  const corrupt = Buffer.alloc(6);
  corrupt.writeUInt32LE(ZSTD_MAGIC, 0);
  corrupt.writeUInt8(0x18, 4); // reserved bits 3-4 set
  let threw = false;
  try {
    scanZstdFrames(corrupt);
  } catch {
    threw = true;
  }
  assert(threw, "expected a reserved-bit error");
  return "reserved frame-header bit rejected";
});

/* ------------------------------------------------------------------ */
/* 3. re-encoding                                                      */
/* ------------------------------------------------------------------ */

check("encodeSessionLog() emits a single valid zstd frame", () => {
  const lines = [headerLine, ...eventLines(30)];
  const encoded = encodeSessionLog(lines, true);
  assert(encoded.readUInt32LE(0) === ZSTD_MAGIC, "output must start with the zstd magic");
  assertEqual(scanZstdFrames(encoded).length, 1, "single frame");
  // The frame must be a real zstd stream: decompress it directly.
  const text = zstdDecompressSync(encoded).toString("utf8");
  assertEqual(text, lines.join("\n") + "\n", "decompressed text");
  return `bytes=${encoded.length}`;
});

check("encodeSessionLog() survives a compress -> decode round-trip", () => {
  const lines = [headerLine, ...eventLines(64)];
  const decoded = decodeSessionLog(encodeSessionLog(lines, true));
  assertEqual(decoded, lines, "round-trip");
  return `lines=${decoded.length}`;
});

check("encodeSessionLog() preserves the header identity", () => {
  const lines = [headerLine, ...eventLines(4)];
  const decoded = decodeSessionLog(encodeSessionLog(lines, true));
  const first = JSON.parse(decoded[0]);
  assertEqual(first.type, "session", "first event type");
  assertEqual(first.version, 4, "format version");
  assertEqual(first.id, SESSION_ID, "session id");
  return first.id;
});

check("encodeSessionLog() handles an empty log", () => {
  const encoded = encodeSessionLog([], true);
  assert(encoded.readUInt32LE(0) === ZSTD_MAGIC, "empty input still produces a frame");
  assertEqual(decodeSessionLog(encoded), [], "empty round-trip");
  return "empty ok";
});

/* ------------------------------------------------------------------ */

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exitCode = 1;
