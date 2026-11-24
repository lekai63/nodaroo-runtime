const fs = require("fs");
const { H, config } = require("./config");
const { log } = require("./util");

// pi 的安装与 provider 配置是下一步扩展点。
// 目前只做检测，避免在未确定 models 前写坏 .paseo/config.json。
function ensurePiProvider() {
  if (!config.piEnabled) {
    log("[pi] disabled by config (piEnabled=false)");
    return;
  }

  const bin = H + "/node_modules/.bin/pi";
  if (!fs.existsSync(bin)) {
    log(
      "[pi] " +
        bin +
        " not found; add @earendil-works/pi-coding-agent to package.json",
    );
    return;
  }

  log("[pi] pi found; provider config is a TODO in src/pi.js");
  // 安装 pi 后按实际模型启用，例如：
  // const { ensureProvider } = require("./paseo-config");
  // ensureProvider("pi", {
  //   enabled: true,
  //   models: [
  //     { id: "zai-coding-cn/glm-5.3", label: "GLM 5.3", isDefault: true },
  //   ],
  // });
}

module.exports = { ensurePiProvider };
