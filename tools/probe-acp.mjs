// 完整 ACP 探测：initialize -> session/new，看 models 是否上报
import { spawn } from "node:child_process";

const child = spawn(process.argv[2] || "vibe-acp", [], {
  cwd: process.env.HOME,
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});

let buf = "";
let errBuf = "";
const pending = new Map();

child.stderr.on("data", (d) => { errBuf += d.toString(); });
child.on("error", (e) => console.log("SPAWN ERROR:", e.message));
child.on("exit", (c, s) => console.log(`[exit code=${c} sig=${s}]`));

child.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { console.log("[non-json]", line.slice(0,200)); continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else {
      console.log("[notify]", JSON.stringify(msg).slice(0, 400));
    }
  }
});

let nextId = 1;
function call(method, params, timeoutMs = 20000) {
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ __timeout: true, method });
    }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const t0 = Date.now();
const init = await call("initialize", {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
});
console.log("=== initialize ===", Date.now() - t0, "ms");
console.log(JSON.stringify(init).slice(0, 600));
if (init.__timeout || init.error) {
  console.log("initialize 失败，终止");
  child.kill("SIGTERM"); process.exit(0);
}

const t1 = Date.now();
const sess = await call("session/new", { cwd: process.env.HOME || "/home/container", mcpServers: [] });
console.log("\n=== session/new ===", Date.now() - t1, "ms");
if (sess.__timeout) {
  console.log("session/new 超时（20s）—— 这会让 paseo 判定探测失败");
} else if (sess.error) {
  console.log("ERROR:", JSON.stringify(sess.error).slice(0, 800));
} else {
  const r = sess.result || {};
  console.log("sessionId:", r.sessionId);
  console.log("models:", JSON.stringify(r.models ?? null).slice(0, 1200));
  console.log("modes:", JSON.stringify(r.modes ?? null).slice(0, 400));
  console.log("configOptions:", JSON.stringify(r.configOptions ?? null).slice(0, 400));
}

console.log("\n=== STDERR ===");
console.log(errBuf.trim().slice(0, 2000) || "(空)");
child.kill("SIGTERM");
setTimeout(() => process.exit(0), 500);
