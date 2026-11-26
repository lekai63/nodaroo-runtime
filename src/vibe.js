const fs = require("fs");
const { VIBE_ACP, config, secrets } = require("./config");
const { log } = require("./util");
const { ensureProvider, providerBaseEnv } = require("./paseo-config");

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

  // API key 绝不能混进 env 白名单：MISTRAL_API_KEY 在下面单独注入。
  const env = providerBaseEnv();
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
