// Pterodactyl MAIN_FILE entry: 入口 + 自更新；运行时逻辑在 src/ 下。
//
// 第一步是从 Git 拉取代码，且这一步**不能依赖 src/ 里的任何文件**：容器里可能只上传了这一个
// index.js（其余文件全靠它拉下来），src/ 不完整时也必须先把代码补齐（见 README「自动从 Git 拉取」）。
// 拉到新代码后，本次启动用的就是新代码（index.js 自身除外，下次启动生效）。
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const H = process.env.NODAROO_HOME || "/home/container";
const DEFAULT_REPO = "https://github.com/lekai63/nodaroo-runtime";
const ASKPASS = H + "/.nodaroo-askpass.sh";
const LOCK = H + "/package-lock.json";
// 记录「上次 npm install 对应的 lock 哈希」，放在 node_modules 里（重装 node_modules 即失效）。
const STAMP = H + "/node_modules/.nodaroo-lock-hash";
// 运行期文件（secrets / config.local.json / .paseo 等）不进 Git。仓库若开始跟踪它们，
// checkout -f 会用仓库里的版本覆盖掉容器里的真实内容，所以更新前先看目标提交有没有跟踪。
const PROTECTED = [
  "secrets.json",
  "config.local.json",
  "paseo-pair.json",
  "paseo-password.txt",
];

function log(s) {
  console.log(s);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

// git / npm 的输出可能带远端 URL（用户信息里可能嵌着 token）或 token 本身，落日志前抹掉。
function clean(s, token) {
  s = String(s || "");
  if (token) s = s.split(token).join("<redacted>");
  return s.replace(/(https?:\/\/)[^@\s/]+@/g, "$1<redacted>@");
}

function tail(s, n = 400) {
  s = String(s || "").trim();
  return s.length > n ? "..." + s.slice(-n) : s;
}

function run(cmd, args, opts = {}) {
  try {
    return {
      ok: true,
      out: execFileSync(cmd, args, {
        cwd: H,
        encoding: "utf8",
        timeout: opts.timeout || 60000,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (e) {
    return {
      ok: false,
      out: String(e.stdout || "") + String(e.stderr || "") + (e.message || ""),
    };
  }
}

// token 只经由 askpass 脚本 + 这几个环境变量传给 git 进程，不进 URL、命令行和本进程环境
// （本进程环境会被 paseo daemon 和各 agent 继承）。
function gitEnv(secrets, token) {
  const env = { GIT_TERMINAL_PROMPT: "0" };
  if (!token) return env;
  fs.writeFileSync(
    ASKPASS,
    '#!/bin/sh\ncase "$1" in\n  *[Uu]sername*) echo "$NODAROO_GIT_USER" ;;\n  *[Pp]assword*) echo "$NODAROO_GIT_TOKEN" ;;\nesac\n',
    { mode: 0o700 },
  );
  fs.chmodSync(ASKPASS, 0o700);
  env.GIT_ASKPASS = ASKPASS;
  env.NODAROO_GIT_USER = String(secrets.gitUser || "git");
  env.NODAROO_GIT_TOKEN = token;
  return env;
}

function lockHash() {
  try {
    return crypto
      .createHash("sha256")
      .update(fs.readFileSync(LOCK))
      .digest("hex");
  } catch (_) {
    return "";
  }
}

function readStamp() {
  try {
    return fs.readFileSync(STAMP, "utf8").trim();
  } catch (_) {
    return null;
  }
}

function writeStamp(v) {
  try {
    fs.mkdirSync(path.dirname(STAMP), { recursive: true });
    fs.writeFileSync(STAMP, v + "\n");
  } catch (_) {}
}

function selfUpdate() {
  const local = readJson(H + "/config.local.json", {});
  const secrets = readJson(H + "/secrets.json", {});
  const branch = local.gitBranch || "main";
  // gitRepo 设为空字符串 "" 表示沿用目录已有的 origin
  const repo =
    local.gitRepo !== undefined ? String(local.gitRepo) : DEFAULT_REPO;
  const token = secrets.gitToken ? String(secrets.gitToken) : "";
  const say = (s) => tail(clean(s, token));
  const git = (args, env, timeout) => run("git", args, { env, timeout });

  if (local.selfUpdate === false) {
    log("[update] disabled by config (selfUpdate=false)");
    return;
  }

  if (!git(["--version"]).ok) {
    log("[update] git not found in container; self-update skipped");
    return;
  }

  // 目录已经是 git 仓库（面板 clone 或上传时带了 .git）时沿用其 origin，否则用配置的 gitRepo 新建。
  const toplevel = git(["rev-parse", "--show-toplevel"]);
  const inRepo =
    toplevel.ok && path.resolve(toplevel.out.trim()) === path.resolve(H);
  const origin = inRepo ? git(["remote", "get-url", "origin"]) : { ok: false };
  if (!repo && !origin.ok) {
    log(
      '[update] no git remote; set "gitRepo" in config.local.json (or upload a git checkout); self-update skipped',
    );
    return;
  }
  if (!inRepo) git(["init", "-q"]);
  if (repo) {
    const args = origin.ok
      ? origin.out.trim() !== repo
        ? ["remote", "set-url", "origin", repo]
        : null
      : ["remote", "add", "origin", repo];
    if (args) git(args);
  }

  const env = gitEnv(secrets, token);
  const target = "origin/" + branch;
  const fetch = git(["fetch", "--quiet", "origin", branch], env, 120000);
  if (!fetch.ok) {
    log("[update] fetch failed; keep current code: " + say(fetch.out));
    return;
  }

  // 面板的 npm install 跑在本脚本之前，装的是拉取前的依赖；lock 变了要自己补装。
  // stamp 不存在时先按「拉取前的 lock」记，这样只有本次拉取改了 lock 才会触发安装。
  const before = lockHash();
  let stamp = readStamp();
  if (stamp === null) {
    stamp = before;
    writeStamp(stamp);
  }

  const tracked = git(["ls-tree", "-r", "--name-only", target]).out.split("\n");
  const hit = tracked.filter(
    (f) => PROTECTED.includes(f) || f.startsWith(".paseo/"),
  );
  if (hit.length) {
    log(
      "[update] refuse to update: remote tracks runtime files " + hit.join(", "),
    );
    return;
  }

  const head = git(["rev-parse", "--verify", "--quiet", "HEAD"]).ok
    ? git(["rev-parse", "--short", "HEAD"]).out.trim()
    : "none";
  const want = git(["rev-parse", "--short", target]).out.trim();
  if (head === want) {
    log("[update] already up to date at " + want);
  } else {
    const co = git(["checkout", "-f", "-B", branch, target], env, 60000);
    if (!co.ok) {
      log("[update] checkout failed; keep current code: " + say(co.out));
      return;
    }
    log("[update] updated " + head + " -> " + want);
  }

  // 上次安装对应的 lock 与当前不一致（本次更新改了依赖，或上次安装失败）就补装。
  // 安装失败时不写 stamp，下次启动会重试。
  const cur = lockHash();
  if (stamp === cur) return;
  log(
    "[update] running npm install (package-lock.json differs from last install) ...",
  );
  const npm = run("npm", ["install", "--no-audit", "--no-fund"], {
    timeout: 900000,
  });
  if (!npm.ok) {
    log(
      "[update] npm install failed (retry next start): " + say(tail(npm.out, 800)),
    );
    return;
  }
  writeStamp(cur);
  log("[update] npm install done");
}

try {
  selfUpdate();
} catch (e) {
  log("[update] ERR " + e.message);
}

require("./src/main").main();
