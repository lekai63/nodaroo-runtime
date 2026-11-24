const fs = require("fs");
const { PASEO_BIN, PASEO_HOME } = require("./config");
const { log, paseoExec } = require("./util");

// 判定一条既有 provider 配置是否"明显失效"，需要纠正后再写回。
//
// 背景（2026-11-24 实测）：在 paseo 客户端 UI 里添加 provider 时，它会写入这样一条：
//   { "extends":"acp", "command":["vibe-acp"], "env":{}, "enabled":false }
// 其中 enabled:false 会让 provider-snapshot-manager 的 resolveCatalog 直接 return，
// 永远不探测模型 —— 表现就是"provider 添加失败 / 认不出模型"。
// 而本函数原来是"已存在就跳过"，导致这类坏配置永远不会被修正。
//
// 采取保守策略：只有当条目**确实不可用**时才修正，避免覆盖用户在 UI 里的有意设置。
//   1) enabled === false         → 用户意图不明，但禁用状态无法被发现，纠正为 true
//   2) command 为空/非字符串数组  → 必然无法启动
//   3) command[0] 不是绝对路径    → 依赖 daemon 的 PATH，容器里不稳定；换成绝对路径
//   4) env 缺失或为空对象         → 补齐我们提供的 env（含 PATH/HOME/API key）
function needsFix(existing, wanted) {
  if (!existing || typeof existing !== "object") return "not-an-object";

  if (existing.enabled === false) return "enabled=false";

  const cmd = existing.command;
  if (!Array.isArray(cmd) || cmd.length === 0 || typeof cmd[0] !== "string" || !cmd[0]) {
    return "bad-command";
  }
  // 裸命令名（不含 /）依赖 PATH 解析，容器环境里不可靠
  if (cmd[0].indexOf("/") < 0) return "relative-command";

  const wantedCmd = wanted.command;
  if (Array.isArray(wantedCmd) && wantedCmd.length > 0 && cmd[0] !== wantedCmd[0]) {
    return "command-mismatch";
  }

  const env = existing.env;
  if (!env || typeof env !== "object" || Object.keys(env).length === 0) return "empty-env";

  // 我们明确要注入的键缺失时也纠正（例如 MISTRAL_API_KEY 后来才配上）。
  // 仅当 wantedEnv 中该键有**非空**值时才要求存在 —— 避免可选变量
  // （如未配置的 MISTRAL_API_KEY）导致每次都判定为需修复。
  const wantedEnv = wanted.env || {};
  for (const k of Object.keys(wantedEnv)) {
    const want = wantedEnv[k];
    if (typeof want !== "string" || want.length === 0) continue;
    if (existing.env[k] === undefined) {
      return "missing-env:" + k;
    }
  }
  return null;
}

// 在 .paseo/config.json 的 agents.providers 里确保一条 provider 配置可用。
// 已存在且可用 → 跳过；已存在但明显失效 → 纠正后写回；不存在 → 写入。
function ensureProvider(id, provider) {
  const cfgPath = PASEO_HOME + "/config.json";
  if (!fs.existsSync(cfgPath)) {
    log("[paseo] config.json not ready; skip provider " + id);
    return false;
  }

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch (e) {
    log("[paseo] config.json parse error: " + e.message);
    return false;
  }

  const providers = (cfg.agents && cfg.agents.providers) || {};
  const existing = providers[id];

  let nextEntry;
  let reason = null;
  if (existing) {
    reason = needsFix(existing, provider);
    if (!reason) {
      log("[paseo] provider " + id + " already configured and usable");
      return true;
    }
    // 保留用户可能自定义的字段（description 等），用我们的值覆盖关键字段。
    nextEntry = {
      ...existing,
      ...provider,
      // enabled 必须为 true，否则不会被加载
      enabled: true,
      // command 用绝对路径，不依赖 daemon 的 PATH
      command: provider.command,
      // env 合并：保留既有自定义项，再补我们的（后者优先）
      env: { ...(existing.env || {}), ...(provider.env || {}) },
    };
    log("[paseo] provider " + id + " config is unusable (" + reason + "); fixing");
  } else {
    nextEntry = provider;
  }

  const next = { ...providers, [id]: nextEntry };
  const out = paseoExec(PASEO_BIN, [
    "daemon",
    "config",
    "set",
    "agents.providers",
    JSON.stringify(next),
    "--home",
    PASEO_HOME,
  ]);
  if (out.indexOf("ERR ") === 0) {
    log("[paseo] configure " + id + " failed: " + out.slice(0, 300));
    return false;
  }
  log(
    "[paseo] provider " +
      id +
      (existing ? " fixed (" + reason + ")" : " configured"),
  );

  const reload = paseoExec(PASEO_BIN, [
    "daemon",
    "reload",
    "--home",
    PASEO_HOME,
  ]);
  if (reload.indexOf("ERR ") === 0) {
    log("[paseo] reload failed; restart once to apply provider " + id);
  } else {
    log("[paseo] config reload requested for provider " + id);
  }
  return true;
}

module.exports = { ensureProvider, needsFix };
