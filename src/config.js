const fs = require("fs");

// 容器内默认 /home/container；本地干跑可用 NODAROO_HOME=/tmp/xxx。
const H = process.env.NODAROO_HOME || "/home/container";
const LOCAL_BIN = H + "/.local/bin";
const VIBE_ACP = LOCAL_BIN + "/vibe-acp";
const PASEO_HOME = H + "/.paseo";
const PASEO_BIN = H + "/node_modules/.bin/paseo";

// 面板不能设任意环境变量：所有子进程统一继承这里。
process.env.PATH =
  LOCAL_BIN + ":" + (process.env.PATH || "/usr/local/bin:/usr/bin:/bin");

const DEFAULTS = {
  publicHost: "se2.nodaroo.fun",
  shoesVersion: "0.3.8",
  realitySni: "european-union.europa.eu",
  realityDest: "european-union.europa.eu:443",
  vmessPath: "/mm",
  vmessHost: "klink5-lf.amemv.com",
  paseoPort: 6768,
  paseoRelay: true,
  vibeEnabled: true,
  piEnabled: false,
};

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error("[config] cannot read " + file + ": " + e.message);
    return fallback;
  }
}

const localConfigPath = H + "/config.local.json";
const localConfig = readJson(localConfigPath, null);
if (!localConfig || !localConfig.publicHost) {
  console.warn(
    "[config] " +
      localConfigPath +
      " missing or has no publicHost; using default " +
      DEFAULTS.publicHost,
  );
}
const config = { ...DEFAULTS, ...(localConfig || {}) };
const secrets = readJson(H + "/secrets.json", {});

module.exports = {
  H,
  LOCAL_BIN,
  VIBE_ACP,
  PASEO_HOME,
  PASEO_BIN,
  config,
  secrets,
  readJson,
};
