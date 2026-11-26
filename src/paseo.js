const { spawn } = require("child_process");
const fs = require("fs");
const crypto = require("crypto");
const { H, PASEO_BIN, PASEO_HOME, config, secrets } = require("./config");
const { log, paseoExec, redact, FD_LIMIT_SHELL } = require("./util");

// 精简镜像（如 nodejs_24）通常没有 ps；paseo 依赖它做三件不同的事，缺任何一个都会
// 出问题（见 src/ps-shim.js 顶部的详细说明）：
//   1) tree-kill        `ps -o pid --no-headers --ppid N`  —— 缺 => daemon 反复崩
//   2) 进程存活检查      `ps -ww -p N -o lstart= -o command=` —— 实现不对 => 误判死进程存活
//   3) terminal worker  `ps -A -ww -o pid= -o ppid= -o sid= -o lstart=` —— 缺 => 误杀/泄漏
// ~/.local/bin 已被 config.js 放到子进程 PATH 最前，hold 一个只读 /proc 的 shim 即可。
const PS_SHIM = H + "/.local/bin/ps";
// shim 内容从 src/ps-shim.js 读取（该文件本身可独立运行/测试），不内嵌字符串。
const PS_SHIM_SOURCE = require("path").join(__dirname, "ps-shim.js");
// 旧版内嵌 shim 的特征行：存在则需重写（升级路径）
const LEGACY_SHIM_MARKER = "if (out.length === 0) process.exit(1);";

function psOnPath() {
  for (const dir of (process.env.PATH || "").split(":")) {
    if (!dir) continue;
    try {
      fs.accessSync(dir + "/ps", fs.constants.X_OK);
      return true;
    } catch (_) {}
  }
  return false;
}

function ensurePsShim() {
  if (psOnPath()) return;
  try {
    fs.mkdirSync(H + "/.local/bin", { recursive: true });
    // 升级路径：旧版 shim 只支持 --ppid，遇到 paseo 的
    // `ps -ww -p N -o lstart= -o command=` 会输出全部 PID，导致“死进程被当成
    // 存活”的误判（进程清理失效）。检测旧特征行就重写。
    let needWrite = true;
    try {
      const cur = fs.readFileSync(PS_SHIM, "utf8");
      if (cur.indexOf(LEGACY_SHIM_MARKER) < 0 && cur.indexOf("POSIX_LSTART_WIDTH") >= 0) {
        needWrite = false;
      } else {
        log("[paseo] upgrading legacy ps shim at " + PS_SHIM);
      }
    } catch (_) {}
    if (needWrite) {
      const body = fs.readFileSync(PS_SHIM_SOURCE, "utf8");
      fs.writeFileSync(PS_SHIM, "#!" + process.execPath + "\n" + body, {
        mode: 0o755,
      });
      fs.chmodSync(PS_SHIM, 0o755);
      log("[paseo] no ps in PATH; wrote /proc-based shim at " + PS_SHIM);
    }
  } catch (e) {
    log("[paseo] WARN cannot write ps shim: " + e.message);
  }
}

function resolvePaseoPassword() {
  if (secrets.paseoPassword) return String(secrets.paseoPassword);
  const f = H + "/paseo-password.txt";
  try {
    if (fs.existsSync(f)) {
      const v = fs.readFileSync(f, "utf8").trim();
      if (v) return v;
    }
  } catch (e) {}
  const v = crypto.randomBytes(24).toString("base64url");
  try {
    fs.writeFileSync(f, v + "\n", { mode: 0o600 });
    fs.chmodSync(f, 0o600);
    log(
      "[paseo] generated password at /home/container/paseo-password.txt (keep secret)",
    );
  } catch (e) {
    log("[paseo] WARN cannot write password file: " + e.message);
  }
  return v;
}

// status 探测超时：paseo status 自己的 RPC 超时是 1.5s，正常 2s 内返回；
// 再留余量给冷启动的 node 加载。watchdog 每 30s 调一次，不能被它拖慢。
const STATUS_TIMEOUT_MS = 10000;
// daemon stop 最坏路径：graceful 15s + kill 3s + 终端回收 5s+3s，给到 30s。
const STOP_TIMEOUT_MS = 30000;

// 一次 status 同时得出两个结论，避免两次探测之间锁状态变化：
//   lockHeld        → 有没有锁（paseo.pid 存在且锁主 PID 仍活着；status 把它报成 pid）
//   daemonReachable → daemon 是否**可用**，而不是「锁主进程还活着」
//
// paseo 的 pid 锁只证明 supervisor 进程存在（pid-lock.js isPidLockOwnerRunning 只做
// kill(pid,0)）；worker 就绪后 supervisor 才把 listen 写进锁。worker 卡在启动里时锁主
// 活着、listen 为 null、永远不会就绪，而 `status` 照样输出 "localDaemon": "running"
// （listen 已发布但端口无人监听时也是如此，只多一条 connectedDaemon: unreachable）。
//
// 2026-11-26 容器实况：PID 139 从 09:54 起就是这种僵尸。旧判定看 localDaemon=running →
// 「已在跑，跳过 spawn」→ pair 轮询 60s 超时；watchdog 判 not running → 重新 spawn →
// 新 supervisor 抢锁失败 "Another Paseo daemon is already running" exit 1 → 循环。
// 所以这里必须看 status 真正连上 daemon 的结论 connectedDaemon=reachable。
function isPaseoRunning() {
  return daemonReachable(statusOutput());
}

function statusOutput() {
  return paseoExec(
    PASEO_BIN,
    ["--home", PASEO_HOME, "--json", "status"],
    { timeout: STATUS_TIMEOUT_MS },
  );
}

// status 无锁时输出 "pid": null，正则的 \d+ 不会误匹配。
function lockHeld(st) {
  return st.indexOf("ERR ") !== 0 && /"pid"\s*:\s*\d+/.test(st);
}

function daemonReachable(st) {
  return (
    st.indexOf("ERR ") !== 0 &&
    /"connectedDaemon"\s*:\s*"reachable"/.test(st)
  );
}

// daemon 在应答但拒绝了我们的凭据（status 输出 auth_required / auth_failed）。
// 这是「活着且在监听」，只是 CLI 没连上 —— 绝不能当僵尸 stop 掉：那会把一个健康的
// daemon 杀掉，而根因只是本进程没拿到 PASEO_PASSWORD（如 local-credential 在锁里
// listen 为 null 时不可用）。只标记、让 pair 流程自己报错。
function daemonAliveAuthRejected(st) {
  return /"connectedDaemon"\s*:\s*"auth_(required|failed)"/.test(st);
}

// 停掉持锁但不可用的 supervisor。paseo stop 对锁主发 SIGTERM 并等它退出（锁随之释放）；
// supervisor 收到信号后先让 worker 优雅退出，10s 未退则对整个进程树 SIGKILL，所以
// 不需要 --force。stop 最坏约 15+3+终端回收，见 STOP_TIMEOUT_MS。
function stopStalePaseo() {
  const out = paseoExec(PASEO_BIN, ["daemon", "stop", "--home", PASEO_HOME], {
    timeout: STOP_TIMEOUT_MS,
  });
  const last = out.trim().split("\n").pop();
  if (out.indexOf("ERR ") === 0) {
    log("[paseo] stop stale daemon failed: " + tailForLog(out));
    return false;
  }
  log("[paseo] stale daemon stopped (" + tailForLog(last) + ")");
  return true;
}

function tailForLog(s) {
  s = String(s || "").trim();
  return s.length > 200 ? "..." + s.slice(-200) : s;
}

function startPaseo(onReady) {
  try {
    if (!fs.existsSync(PASEO_BIN)) {
      log(
        "[paseo] " +
          PASEO_BIN +
          " not found; check npm install / package.json",
      );
      return;
    }

    ensurePsShim();

    const password = resolvePaseoPassword();
    process.env.PASEO_PASSWORD = password;
    fs.mkdirSync(PASEO_HOME, { recursive: true });

    // 一次 status 同时得出两个结论，避免两次探测之间锁状态变化。
    const st = statusOutput();
    if (daemonReachable(st)) {
      log("[paseo] daemon already running; reusing existing instance (skip spawn)");
      waitForPaseoAndPair(0, onReady);
      return;
    }

    // daemon 在应答但凭据被拒：不是僵尸，不动它（见 daemonAliveAuthRejected）。
    // 也不进 pair 轮询（连不上，只会再报 60s 超时）；日志留给人排查 paseoPassword。
    if (daemonAliveAuthRejected(st)) {
      log(
        "[paseo] daemon is up but rejected our credential; not touching it (check paseoPassword)",
      );
      if (onReady) onReady();
      return;
    }

    // 有锁但不可用 = 僵尸 supervisor。不停掉它，新 daemon 永远抢不到锁。
    if (lockHeld(st)) {
      log(
        "[paseo] pid lock held but daemon unreachable (stale supervisor); stopping it",
      );
      stopStalePaseo();
    }

    const p = spawn(
      "/bin/sh",
      ["-c", FD_LIMIT_SHELL, process.execPath, PASEO_BIN, "daemon", "run", "--home", PASEO_HOME],
      {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PASEO_HOME,
          PASEO_LISTEN: "127.0.0.1:" + config.paseoPort,
          PASEO_RELAY_ENABLED: config.paseoRelay ? "true" : "false",
          PASEO_PASSWORD: password,
        },
      },
    );
    p.stdout.on("data", (d) => log("[paseo] " + redact(d.toString().trim())));
    p.stderr.on("data", (d) => log("[paseo] " + redact(d.toString().trim())));
    p.on("error", (e) => log("[paseo] spawn error " + e.message));
    p.on("exit", (code, signal) =>
      log("[paseo] exited code=" + code + " signal=" + signal),
    );
    p.unref();

    log(
      "paseo daemon starting on 127.0.0.1:" +
        config.paseoPort +
        " (relay " +
        (config.paseoRelay ? "enabled" : "disabled") +
        ")",
    );
    waitForPaseoAndPair(0, onReady);
  } catch (e) {
    log("[paseo] start failed: " + e.message);
  }
}

function waitForPaseoAndPair(attempt, onReady) {
  const maxAttempts = 30;
  if (attempt > maxAttempts) {
    log(
      "[paseo] pair timeout; run manually: " +
        PASEO_BIN +
        " --json --home " +
        PASEO_HOME +
        " pair --relay",
    );
    if (onReady) onReady();
    return;
  }

  if (isPaseoRunning()) {
    const pairArgs = ["--json", "--home", PASEO_HOME, "pair"];
    if (config.paseoRelay) pairArgs.push("--relay");
    const out = paseoExec(PASEO_BIN, pairArgs);
    if (out.indexOf("ERR ") !== 0) {
      try {
        fs.writeFileSync(H + "/paseo-pair.json", out, { mode: 0o600 });
        fs.chmodSync(H + "/paseo-pair.json", 0o600);
        log(
          "[paseo] pairing URI written to /home/container/paseo-pair.json (treat as secret)",
        );
      } catch (e) {
        log("[paseo] cannot write pairing file: " + e.message);
      }
    } else {
      log("[paseo] pair failed; see daemon log");
    }
    if (onReady) onReady();
    return;
  }
  setTimeout(() => waitForPaseoAndPair(attempt + 1, onReady), 2000);
}

module.exports = { startPaseo, waitForPaseoAndPair, ensurePsShim, isPaseoRunning };
