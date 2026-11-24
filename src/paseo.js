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

// 用 paseo 自己的 status 判断，避免重复 spawn 时它打印
// "Another Paseo daemon is already running" 后退出，日志里像崩了一样。
function isPaseoRunning() {
  const st = paseoExec(PASEO_BIN, [
    "--json",
    "--home",
    PASEO_HOME,
    "status",
  ]);
  return st.indexOf("ERR ") !== 0 && /"localDaemon"\s*:\s*"running"/.test(st);
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

    if (isPaseoRunning()) {
      log("[paseo] daemon already running; reusing existing instance (skip spawn)");
      waitForPaseoAndPair(0, onReady);
      return;
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
