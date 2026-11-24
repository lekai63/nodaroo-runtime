const fs = require("fs");
const { VIBE_ACP, config, secrets } = require("./config");
const { log } = require("./util");
const { ensureProvider } = require("./paseo-config");

function ensureVibeProvider() {
  if (!config.vibeEnabled) {
    log("[vibe] disabled by config");
    return;
  }
  if (!fs.existsSync(VIBE_ACP)) {
    // 直接给可执行的修复指令，避免人卡在"为什么 provider 列表里没有它"。
    log(
      "[vibe] " +
        VIBE_ACP +
        " not found; provider not registered. Install with: " +
        "curl -LsSf https://mistral.ai/vibe/install.sh | bash",
    );
    return;
  }
  try {
    fs.accessSync(VIBE_ACP, fs.constants.X_OK);
  } catch (e) {
    log("[vibe] not executable: " + e.message);
    return;
  }

  // env 必须足够完整：paseo 的 provider override env 会落盘到 config.json，
  // 且是其子进程环境的增量。若只给 PATH，vibe-acp（Python/uv 安装）可能因缺
  // HOME / XDG_* / VIRTUAL_ENV 而启动失败。
  // 但**绝不能把所有环境变量都写进去**（config.json 是明文，会泄漏 PASEO_PASSWORD、
  // 各类 token）。这里采用白名单：除下列 env 白名单键外，MISTRAL_API_KEY 单独注入。
  const ENV_KEEP = ["HOME", "PATH", "LANG", "LC_ALL", "TERM", "SHELL", "TMPDIR", "USER"];
  const env = {};
  for (const k of ENV_KEEP) {
    if (process.env[k]) env[k] = process.env[k];
  }
  // uv / Python 工具链常依赖的变量，存在才带（不写死空值）
  for (const k of Object.keys(process.env)) {
    if (/^(XDG_|UV_|VIRTUAL_ENV|PYTHON)/.test(k) && process.env[k]) {
      env[k] = process.env[k];
    }
  }
  if (secrets.mistralApiKey) {
    env.MISTRAL_API_KEY = String(secrets.mistralApiKey);
  }

  ensureProvider("mistral-vibe", {
    extends: "acp",
    command: [VIBE_ACP],
    label: "Mistral Vibe",
    enabled: true,
    env,
  });
}

module.exports = { ensureVibeProvider };
