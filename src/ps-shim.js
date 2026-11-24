// /proc 版 ps 兼容 shim（容器镜像缺 procps 时由 src/paseo.js 落盘到 ~/.local/bin/ps）。
//
// 为什么需要它：paseo 依赖 ps 做三件不同的事，调用形态各不相同，缺任何一个都会出问题。
//   1) tree-kill:        ps -o pid --no-headers --ppid <PID>
//      —— 枚举子进程。真 ps 在无匹配时退出码 1；必须对齐，否则 tree-kill 用
//         allData.match(/\d+/g).forEach(...) 撞 null 抛 TypeError（daemon 崩）。
//   2) managed-processes: ps -ww -p <PID> -o lstart= -o command=
//      —— 判断某 PID 是否存活并取启动时间/命令行。必须只输出该 PID 的一行、
//         格式为 "<lstart 24字符><command>"；否则 paseo 会把任意数字串当 argv，
//         误判死进程仍存活（曾导致进程清理逻辑失效）。
//   3) terminal-worker:   ps -A -ww -o pid= -o ppid= -o sid= -o lstart=
//      —— 全量快照，每行 "pid ppid sid <lstart>"（lstart 可含空格，靠行尾匹配）。
//
// 输出约定：所有 -o xxx= 形式按 BSD 空表头输出；--no-headers 免除表头。
// 无匹配时：形态 1 退出码 1（tree-kill 语义），其余退出 1 且无输出（同真 ps）。

const fs = require("fs");

const POSIX_LSTART_WIDTH = 24;

function parseArgs(argv) {
  const opts = {
    pidFilter: null,
    ppidFilter: null,
    all: false,
    noHeaders: false,
    columns: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--no-headers" || a === "--noheader") {
      opts.noHeaders = true;
    } else if (a === "-A" || a === "-e" || a === "aux") {
      opts.all = true;
    } else if (a === "-ww" || a === "-w" || a === "w") {
      // 宽输出，本 shim 不限宽，忽略
    } else if (a === "-p") {
      const raw = next();
      const n = Number(raw);
      if (Number.isInteger(n) && n > 0) opts.pidFilter = n;
    } else if (a === "--ppid") {
      const raw = next();
      const n = Number(raw);
      if (Number.isInteger(n) && n >= 0) opts.ppidFilter = n;
    } else if (a === "-o") {
      const spec = next();
      if (typeof spec === "string" && spec.length > 0) opts.columns.push(spec);
    } else if (a.startsWith("--ppid=")) {
      const n = Number(a.slice("--ppid=".length));
      if (Number.isInteger(n) && n >= 0) opts.ppidFilter = n;
    } else if (a.startsWith("-p=")) {
      const n = Number(a.slice(3));
      if (Number.isInteger(n) && n > 0) opts.pidFilter = n;
    }
  }
  return opts;
}

function readStat(pid) {
  try {
    const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    const close = stat.lastIndexOf(")");
    const rest = stat.slice(close + 2).trim().split(/\s+/);
    // rest[0]=state rest[1]=ppid rest[2]=pgrp rest[3]=session
    return {
      pid,
      state: rest[0],
      ppid: Number(rest[1]),
      session: Number(rest[3]),
    };
  } catch (_) {
    return null;
  }
}

function readStartAndCommand(pid) {
  let startedAt = "";
  try {
    const st = fs.statSync("/proc/" + pid);
    // ps 的 lstart 为 24 列 "Day Mon DD HH:MM:SS YYYY"
    const d = st.birthtimeMs ? new Date(st.birthtimeMs) : new Date(st.ctimeMs);
    const pad = (v) => String(v).padStart(2, "0");
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const mons = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const day = days[d.getDay()];
    const mon = mons[d.getMonth()];
    const dd = String(d.getDate()).padStart(2, " ");
    const time = pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
    startedAt = day + " " + mon + " " + dd + " " + time + " " + d.getFullYear();
  } catch (_) {
    startedAt = "";
  }
  let commandLine = "";
  try {
    const raw = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8");
    commandLine = raw.split("\0").filter((x) => x.length > 0).join(" ");
  } catch (_) {}
  if (!commandLine) {
    try {
      commandLine = "[" + fs.readFileSync("/proc/" + pid + "/comm", "utf8").trim() + "]";
    } catch (_) {}
  }
  return { startedAt, commandLine };
}

function allPids() {
  const out = [];
  let names;
  try {
    names = fs.readdirSync("/proc");
  } catch (_) {
    return out;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    out.push(Number(name));
  }
  out.sort((a, b) => a - b);
  return out;
}

function columnValue(col, pid, stat) {
  const key = col.replace(/=$/, "").trim();
  switch (key) {
    case "pid":
      return String(pid);
    case "ppid":
      return String(stat ? stat.ppid : 0);
    case "sid":
    case "session":
      return String(stat ? stat.session : 0);
    case "lstart":
      return readStartAndCommand(pid).startedAt;
    case "command":
    case "cmd":
    case "args":
      return readStartAndCommand(pid).commandLine;
    case "comm":
      return (() => {
        try {
          return fs.readFileSync("/proc/" + pid + "/comm", "utf8").trim();
        } catch (_) {
          return "";
        }
      })();
    default:
      return "";
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  // 形态 2：单 PID 查询（-p）——必须严格只输出该 PID。
  if (opts.pidFilter !== null) {
    const stat = readStat(opts.pidFilter);
    if (!stat) process.exit(1);
    const { startedAt, commandLine } = readStartAndCommand(opts.pidFilter);
    if (opts.columns.length > 0) {
      const parts = opts.columns.map((c) => {
        const k = c.replace(/=$/, "").trim();
        if (k === "lstart") return startedAt.padEnd(POSIX_LSTART_WIDTH);
        if (k === "command" || k === "cmd" || k === "args") return commandLine;
        return columnValue(c, opts.pidFilter, stat);
      });
      process.stdout.write(parts.join(" ").replace(/\s+$/, "") + "\n");
    } else {
      process.stdout.write(
        startedAt.padEnd(POSIX_LSTART_WIDTH) + commandLine + "\n",
      );
    }
    return;
  }

  // 形态 3：全量快照（-A）与形态 1：按 ppid 过滤。
  let pids = allPids();
  if (opts.ppidFilter !== null) {
    pids = pids.filter((pid) => {
      const st = readStat(pid);
      return st !== null && st.ppid === opts.ppidFilter;
    });
    if (pids.length === 0 && opts.columns.length === 0) {
      // tree-kill 形态：无子进程退出 1（真 ps 语义）
      process.exit(1);
    }
    if (pids.length === 0) process.exit(1);
    if (opts.columns.length === 0) {
      // tree-kill 只传 -o pid（无等号），输出纯 pid 列表
      process.stdout.write(pids.map(String).join("\n") + "\n");
      return;
    }
    const rows = pids.map((pid) => {
      const st = readStat(pid);
      return opts.columns.map((c) => columnValue(c, pid, st)).join(" ");
    });
    process.stdout.write(rows.join("\n") + "\n");
    return;
  }

  if (opts.columns.length === 0) {
    process.stdout.write(pids.map(String).join("\n") + "\n");
    return;
  }

  const rows = [];
  for (const pid of pids) {
    const st = readStat(pid);
    rows.push(opts.columns.map((c) => columnValue(c, pid, st)).join(" "));
  }
  process.stdout.write(rows.join("\n") + "\n");
}

main();
