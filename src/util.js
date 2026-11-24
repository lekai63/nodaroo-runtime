const { execSync, execFileSync } = require("child_process");
const http = require("http");

const logs = [];

// 防御性用 /bin/sh 包一层把 fd 软限制抬到硬限制（不越界、不需 root），再 exec 真正的命令。
// 注：之前容器里 shoes 报的 "No file descriptors available (os error 24)" 实为
// inotify per-UID 配额耗尽（见 shoes.js --no-reload 注释），与 per-process fd 限额
// 无关；此包装作为通用加固保留。
const FD_LIMIT_SHELL =
  'echo "[fd] wrapper soft=$(ulimit -Sn) hard=$(ulimit -Hn) fds=$(set -- /proc/$$/fd/*; echo $#)" >&2; ' +
  'ulimit -Sn $(ulimit -Hn) 2>/dev/null || true; exec "$0" "$@"';

function log(s) {
  s = String(s);
  logs.push(new Date().toISOString() + " " + s);
  if (logs.length > 400) logs.shift();
  console.log(s);
}

function sh(c) {
  try {
    return execSync(c, { timeout: 180000 }).toString();
  } catch (e) {
    return (
      "ERR " +
      c +
      ": " +
      (e.stdout ? e.stdout.toString() : "") +
      (e.stderr ? e.stderr.toString() : "") +
      (e.message || "")
    );
  }
}

// 用 execFile 而不是 shell 拼接，避免 provider JSON 被 shell 展开。
function paseoExec(bin, args) {
  try {
    return execFileSync(process.execPath, [bin, ...args], {
      timeout: 180000,
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
  } catch (e) {
    return (
      "ERR " +
      args.join(" ") +
      ": " +
      (e.stdout ? e.stdout.toString() : "") +
      (e.stderr ? e.stderr.toString() : "") +
      (e.message || "")
    );
  }
}

function redact(s) {
  return String(s)
    .replace(/relay:\/\/\S+/g, "relay://<redacted>")
    .replace(/([?&]password=)[^&\s]+/g, "$1<redacted>")
    .replace(/([?&]key=)[^&\s]+/g, "$1<redacted>");
}

function assetTarget() {
  if (process.arch === "x64") return "x86_64";
  if (process.arch === "arm64") return "aarch64";
  return null;
}

function startStatusPage(port) {
  http
    .createServer((q, r) => r.end(logs.join("\n") || "booting"))
    .on("error", (e) => log("http status err " + e.message))
    .listen(port, () => log("HTTP status on " + port));
}

module.exports = {
  logs,
  log,
  sh,
  paseoExec,
  redact,
  assetTarget,
  startStatusPage,
  FD_LIMIT_SHELL,
};
