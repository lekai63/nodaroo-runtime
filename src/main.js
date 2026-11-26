const fs = require("fs");
const { config, PASEO_BIN } = require("./config");
const { log, sh, startStatusPage } = require("./util");
const { startShoes } = require("./shoes");
const { startPaseo, isPaseoRunning } = require("./paseo");
const { ensureVibeProvider } = require("./vibe");
const { ensureNativeProviders } = require("./native-providers");

// 依次尝试探针命令，返回第一个成功输出的首行（sh() 失败返回 "ERR ..." 前缀，跳过）。
function firstOk(cmds) {
  for (const c of cmds) {
    const out = sh(c).trim().split("\n")[0];
    if (out && out.indexOf("ERR ") !== 0) return out;
  }
  return "unknown";
}

function main() {
  log(
    "=== NODAROO RUNTIME START arch=" +
      process.arch +
      " publicHost=" +
      config.publicHost +
      " ===",
  );
  // inotify 三个指标用于定位 errno 24：shoes 0.3.x 非 dry-run 启动即建 inotify
  // watcher，而 max_user_instances 是宿主上 per-UID 全局配额，占满时 inotify_init
  // 返回 EMFILE(24)，报 "No file descriptors available"，极像 fd 限额——实际无关。
  // inotify-held 只统计本 pid namespace 可见的进程，耗尽配额的可能是宿主上同 UID
  // 的其他容器/进程（不可见计数虽为 0 也可能已耗尽），修复是 shoes --no-reload。
  // libc= 探测容器 glibc/musl（shoes 本身是静态 musl，不受宿主 libc 影响）。
  log(
    "[env] fd soft=" +
      sh("ulimit -Sn").trim() +
      " hard=" +
      sh("ulimit -Hn").trim() +
      " file-nr=" +
      sh("cat /proc/sys/fs/file-nr 2>/dev/null").trim() +
      " self-fds=" +
      sh("ls /proc/self/fd 2>/dev/null | wc -l").trim() +
      " inotify-instances=" +
      sh(
        "cat /proc/sys/fs/inotify/max_user_instances 2>/dev/null",
      ).trim() +
      " inotify-watches=" +
      sh("cat /proc/sys/fs/inotify/max_user_watches 2>/dev/null").trim() +
      " inotify-held=" +
      sh(
        "find /proc/[0-9]*/fd -lname 'anon_inode:inotify' 2>/dev/null | wc -l",
      ).trim() +
      " libc=" +
      firstOk([
        "getconf GNU_LIBC_VERSION",
        "ldd --version 2>/dev/null | head -1",
      ]),
  );

  startShoes();
  startPaseo(() => {
    ensureVibeProvider();
    ensureNativeProviders();
  });

  const statusPort = parseInt(process.env.SHOES_STATUS_PORT || "", 10);
  if (statusPort) startStatusPage(statusPort);
  else log("status page off (set SHOES_STATUS_PORT to enable)");

  // daemon 存活看护：没有它，daemon 一旦退出就再也不会被拉起（只能重启容器）。
  // 真实故障：2026-11-24 06:37 后 daemon 静默消失，无任何 crash 日志，客户端从此只能转圈。
  // 同时这个 interval 充当入口进程的保活 handle。
  const WATCHDOG_MS = 30000;
  let downStreak = 0;
  setInterval(() => {
    try {
      if (!fs.existsSync(PASEO_BIN)) return;
      if (isPaseoRunning()) {
        if (downStreak > 0)
          log("[watchdog] paseo recovered after " + downStreak + " failed checks");
        downStreak = 0;
        return;
      }
      downStreak++;
      log(
        "[watchdog] paseo daemon not running (streak=" + downStreak + ")",
      );
      // 连续两次确认才重启，避开启动瞬间的误报；退避避免疯狂重启。
      if (downStreak === 2 || downStreak % 10 === 0) {
        log("[watchdog] restarting paseo daemon");
        startPaseo(() => {
          ensureVibeProvider();
          ensureNativeProviders();
        });
      }
    } catch (e) {
      log("[watchdog] ERR " + e.message);
    }
  }, WATCHDOG_MS);

  log("=== NODAROO RUNTIME END ===");
}

module.exports = { main };
