const { spawn } = require("child_process");
const fs = require("fs");
const { H, config, secrets } = require("./config");
const { log, sh, assetTarget, FD_LIMIT_SHELL } = require("./util");

function startShoes() {
  try {
    if (
      !secrets.realityPrivateKey ||
      !secrets.realityPublicKey ||
      !secrets.realityShortId ||
      !secrets.vlessUserId
    ) {
      log(
        "[shoes] secrets.json missing realityPrivateKey/realityPublicKey/realityShortId/vlessUserId; skip shoes",
      );
      return;
    }

    const PORT = parseInt(process.env.SERVER_PORT || "25744", 10);
    const WS_PORT = process.env.SHOES_WS_PORT
      ? parseInt(process.env.SHOES_WS_PORT, 10)
      : null;

    // 1) shoes 二进制：只下载一次
    const target = assetTarget();
    if (!target) throw new Error("unsupported arch " + process.arch);
    if (!fs.existsSync(H + "/shoes")) {
      const asset = "shoes-" + target + "-unknown-linux-musl.tar.gz";
      const url =
        "https://github.com/cfal/shoes/releases/download/v" +
        config.shoesVersion +
        "/" +
        asset;
      log("downloading " + asset + " ...");
      log(
        sh(
          "cd " + H +
            " && curl -fsSL --retry 3 -o shoes.tgz " + url +
            " && tar xzf shoes.tgz shoes" +
            " && rm -f shoes.tgz && chmod +x shoes",
        ),
      );
    }
    log("shoes " + sh(H + "/shoes --version").split("\n")[0].trim());

    // 2) config.yaml
    const withWs = WS_PORT && WS_PORT !== PORT && secrets.vmessUserId;
    if (WS_PORT && WS_PORT !== PORT && !secrets.vmessUserId) {
      log("[shoes] vmessUserId missing; WS inbound skipped");
    }

    let cfg = `# 由 nodaroo-runtime 自动生成：Reality + VLESS + Vision
# SNI/dest 借用真实站点 ${config.realitySni}；证书由目标站应答，本机无需持有证书
- address: "0.0.0.0:${PORT}"
  protocol:
    type: tls
    reality_targets:
      "${config.realitySni}":
        private_key: "${secrets.realityPrivateKey}"
        short_ids: ["${secrets.realityShortId}"]
        dest: "${config.realityDest}"
        max_time_diff: 60000
        vision: true
        protocol:
          type: vless
          user_id: "${secrets.vlessUserId}"
          udp_enabled: true
`;
    if (withWs) {
      cfg += `
# 免流入口：VMess over WebSocket + Host 伪装
- address: "0.0.0.0:${WS_PORT}"
  transport: tcp
  protocol:
    type: ws
    targets:
      - matching_path: "${config.vmessPath}"
        matching_headers:
          Host: "${config.vmessHost}"
        protocol:
          type: vmess
          cipher: any
          user_id: "${secrets.vmessUserId}"
  rules:
    - mask: 0.0.0.0/0
      action: allow
      client_chain: direct
`;
    }
    fs.writeFileSync(H + "/config.yaml", cfg);
    log(
      "config.yaml written: 0.0.0.0:" + PORT +
        (withWs ? " + 0.0.0.0:" + WS_PORT : ""),
    );

    const check = sh(H + "/shoes check " + H + "/config.yaml");
    log("shoes check: " + check.trim().split("\n").join(" | "));
    if (check.indexOf("Configuration valid") < 0)
      throw new Error("config check failed, see log above");

    // 3) 后台启动 shoes
    // --no-reload 是必须的：shoes 0.3.x 非 dry-run 启动的第一步就是建 inotify watcher
    // （ConfigWatches，用于配置热重载），而 fs.inotify.max_user_instances 是宿主上
    // per-UID 的全局配额（默认 128），被同 UID 的进程/容器占满时 inotify_init 返回
    // EMFILE(errno 24)，musl 的报错串恰为 "No file descriptors available (os error 24)"
    // ——极像 fd 限额问题（容器里 fd soft=hard=524288 仍报此错，已实测证实是配额）。
    // dry-run 的 `shoes check` 不建 watcher，所以它总是通过、实跑才挂。
    // 本 runtime 每次启动都重写 config.yaml，进程内热重载没有意义；
    // --no-reload 完全跳过 watcher（本地实验：占满配额时仍能正常 Servers ready）。
    // 手动重载能力保留：kill -HUP <shoes pid>。
    log(
      "[shoes] spawning: " +
        H + "/shoes --no-reload -l " + H + "/shoes.log " + H + "/config.yaml",
    );
    const proc = spawn(
      "/bin/sh",
      [
        "-c",
        FD_LIMIT_SHELL,
        H + "/shoes",
        "--no-reload",
        "-l",
        H + "/shoes.log",
        H + "/config.yaml",
      ],
      {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, RUST_BACKTRACE: "1" },
      },
    );
    proc.stdout.on("data", (d) => log("[shoes] " + d.toString().trim()));
    proc.stderr.on("data", (d) => log("[shoes] " + d.toString().trim()));
    proc.on("exit", (code, signal) =>
      log("[shoes] exited code=" + code + " signal=" + signal),
    );
    proc.unref();

    // 4) 客户端配置
    const clientYaml = `# shoes 客户端：本地 127.0.0.1:1080 SOCKS5 -> ${config.publicHost}:${PORT}
# 用法：shoes client.yaml（另存为 client.yaml）
- address: "127.0.0.1:1080"
  protocol:
    type: socks
  rules:
    - masks: "0.0.0.0/0"
      action: allow
      client_chain:
        address: "${config.publicHost}:${PORT}"
        protocol:
          type: reality
          public_key: "${secrets.realityPublicKey}"
          short_id: "${secrets.realityShortId}"
          sni_hostname: "${config.realitySni}"
          vision: true
          protocol:
            type: vless
            user_id: "${secrets.vlessUserId}"
`;
    fs.writeFileSync(H + "/client.yaml.txt", clientYaml);
    log("--- client.yaml.txt (粘贴到客户端即可) ---");
    log(clientYaml);

    log(
      "Reality 参数: server=" + config.publicHost + " port=" + PORT +
        " pbk=" + secrets.realityPublicKey +
        " sid=" + secrets.realityShortId +
        " sni=" + config.realitySni +
        " flow=xtls-rprx-vision type=vless",
    );
    if (withWs) {
      log(
        "VMess+WS 参数: server=" + config.publicHost + " port=" + WS_PORT +
          " path=" + config.vmessPath + " host=" + config.vmessHost +
          " uuid=" + secrets.vmessUserId + " cipher=any tls=none",
      );
    }
  } catch (e) {
    log("shoes setup ERR " + e.message);
  }
}

module.exports = { startShoes };
