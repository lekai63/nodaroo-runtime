const fs = require("fs");
const { NPM_BIN, config } = require("./config");
const { log } = require("./util");
const { ensureProvider, providerBaseEnv } = require("./paseo-config");

// paseo 内置（原生）provider：CLI 由 package.json 的 dependencies 经 npm install 落到
// node_modules/.bin，所以容器默认自带。条目不写 extends（它们不是 acp 派生）、不写
// models（模型由 CLI 运行时上报）；command 用绝对路径，不依赖 daemon 的 PATH。
const NATIVE_PROVIDERS = [
  { id: "pi", enabledKey: "piEnabled" },
  { id: "opencode", enabledKey: "opencodeEnabled" },
];

function ensureNativeProviders() {
  for (const p of NATIVE_PROVIDERS) ensureNativeProvider(p);
}

function ensureNativeProvider({ id, enabledKey }) {
  if (!config[enabledKey]) {
    log("[" + id + "] disabled by config (" + enabledKey + "=false)");
    return;
  }

  const bin = NPM_BIN + "/" + id;
  if (!fs.existsSync(bin)) {
    log(
      "[" + id + "] " + bin + " not found; check npm install / package.json",
    );
    return;
  }

  ensureProvider(id, { command: [bin], enabled: true, env: providerBaseEnv() });
}

module.exports = { ensureNativeProviders };
