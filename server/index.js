#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  appendInbox,
  clearPid,
  drainInbox,
  hasWake,
  isAllowed,
  isConfigured,
  isProcessed,
  loadState,
  loadWake,
  markProcessed,
  monitorRunning,
  paths,
  peekInboxCount,
  saveWake,
  setDedicatedAssistant,
  statusPayload,
  updateState,
  writePid,
} from "./store.js";
import {
  configInit,
  configShow,
  larkCliPath,
  normalizeEvent,
  replyMessage,
  sendMessage,
  spawnEventConsume,
  whoami,
} from "./lark.js";
import {
  connectorAbandoned,
  registerShutdownCleanup,
  runUninstall,
  touchConnectorActive,
  uninstallFeishu,
} from "./uninstall.js";

const self = fileURLToPath(import.meta.url);
const MAX_EVENT_AGE_MS = 10 * 60 * 1000;

try {
  fs.mkdirSync("/workspace/.grok-feishu", { recursive: true });
  fs.appendFileSync(
    "/workspace/.grok-feishu/mcp-host.log",
    `${new Date().toISOString()} spawn pid=${process.pid} argv=${JSON.stringify(process.argv)} cwd=${process.cwd()}\n`,
  );
} catch {
  /* ignore */
}
try {
  if (process.stdout._handle?.setBlocking) process.stdout._handle.setBlocking(true);
  if (process.stdin._handle?.setBlocking) process.stdin._handle.setBlocking(true);
} catch {
  /* ignore */
}

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(message) {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

function ensureMonitor() {
  const existing = monitorRunning();
  if (existing) return { already_running: true, pid: existing };
  if (!isConfigured()) return { started: false, reason: "not_configured" };
  const child = spawn(process.execPath, [self, "--monitor"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  writePid(child.pid);
  return { started: true, pid: child.pid };
}

const tools = {
  feishu_config_init: {
    description:
      "用飞书开放平台应用凭证初始化 lark-cli（bot 身份）。必填 app_id + app_secret（或环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET）。secret 经 stdin 传入，不写入本插件状态文件。",
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "飞书应用 App ID，如 cli_xxx" },
        app_secret: { type: "string", description: "飞书应用 App Secret（勿写入日志/聊天）" },
        brand: {
          type: "string",
          enum: ["feishu", "lark"],
          description: "品牌，默认 feishu",
        },
      },
    },
    handle: async ({ app_id, app_secret, brand }) =>
      ok(configInit({ appId: app_id, appSecret: app_secret, brand })),
  },
  feishu_status: {
    description:
      "查看应用是否已配置、wake、专属助手、allowlist、inbox、monitor 是否在跑、lark-cli whoami。",
    inputSchema: { type: "object", properties: {} },
    handle: async () => {
      const payload = statusPayload();
      payload.monitor_pid = monitorRunning();
      try {
        payload.lark_cli_path = larkCliPath();
        payload.whoami = whoami();
      } catch (err) {
        payload.lark_cli_error = err instanceof Error ? err.message : String(err);
      }
      try {
        payload.config_show = configShow();
      } catch {
        // ignore
      }
      return ok(payload);
    },
  },
  feishu_inbox: {
    description:
      "立即取出 monitor 缓存的入站消息（取出后清空）。每条含 message_id、chat_id、sender_id、content/text。",
    inputSchema: { type: "object", properties: {} },
    handle: async () => ok({ messages: drainInbox(), from_monitor: true }),
  },
  feishu_set_wake: {
    description:
      "保存入站 webhook（wake.json，权限 600）。url/key 来自 Routine「飞书入站唤醒」面板，粘贴一次即可。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "webhook 地址" },
        key: { type: "string", description: "webhook 密钥" },
      },
      required: ["url", "key"],
    },
    handle: async ({ url, key }) => {
      saveWake(url, key);
      return ok({ wake_configured: true, url_host: (() => {
        try {
          return new URL(url).host;
        } catch {
          return "";
        }
      })() });
    },
  },
  feishu_set_dedicated_assistant: {
    description:
      "为当前飞书应用登记专属 Grok Bot 助手 id/名称，供入站转交与卸载侧栏列表。",
    inputSchema: {
      type: "object",
      properties: {
        assistant_id: { type: "string", description: "专属助手 id" },
        assistant_name: { type: "string", description: "专属助手侧栏名称（如「飞书1」）" },
        app_id: { type: "string", description: "可选，校验用" },
      },
      required: ["assistant_name"],
    },
    handle: async ({ assistant_id, assistant_name, app_id }) => {
      const state = setDedicatedAssistant(assistant_id, assistant_name);
      if (app_id && state.appId && app_id !== state.appId) {
        return ok({
          warning: `app_id 与已配置不一致：configured=${state.appId} given=${app_id}`,
          dedicated_assistant: state.dedicatedAssistant,
        });
      }
      return ok({ dedicated_assistant: state.dedicatedAssistant });
    },
  },
  feishu_send: {
    description:
      "用 bot 身份发消息。提供 chat_id 或 user_id（open_id），以及 text 或 markdown。包装 lark-cli im +messages-send --as bot。",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "会话 ID（oc_xxx）" },
        user_id: { type: "string", description: "用户 open_id（ou_xxx），与 chat_id 二选一" },
        text: { type: "string", description: "纯文本" },
        markdown: { type: "string", description: "Markdown（自动转 post）" },
      },
    },
    handle: async ({ chat_id, user_id, text, markdown }) =>
      ok(sendMessage({ chatId: chat_id, userId: user_id, text, markdown })),
  },
  feishu_reply: {
    description:
      "用 bot 身份回复某条消息。必填 message_id，以及 text 或 markdown。包装 lark-cli im +messages-reply --as bot。",
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "被回复消息 ID（om_xxx）" },
        text: { type: "string" },
        markdown: { type: "string" },
        reply_in_thread: { type: "boolean", description: "是否在话题内回复" },
      },
      required: ["message_id"],
    },
    handle: async ({ message_id, text, markdown, reply_in_thread }) =>
      ok(
        replyMessage({
          messageId: message_id,
          text,
          markdown,
          replyInThread: Boolean(reply_in_thread),
        }),
      ),
  },
  feishu_start_monitor: {
    description:
      "后台启动长连接：lark-cli event consume im.message.receive_v1 --as bot。收到事件写入 inbox 并 POST wake webhook。已在跑则直接返回。",
    inputSchema: { type: "object", properties: {} },
    handle: async () => ok(ensureMonitor()),
  },
  feishu_stop_monitor: {
    description: "停止后台长连接 monitor。",
    inputSchema: { type: "object", properties: {} },
    handle: async () => {
      const pid = monitorRunning();
      if (!pid) return ok({ stopped: true, was_running: false });
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* ignore */
      }
      clearPid();
      return ok({ stopped: true, pid });
    },
  },
  feishu_approve: {
    description:
      "把 open_id 加入 allowlist。空列表表示接收全部私信；非空则只处理名单内用户。",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "飞书用户 open_id（ou_xxx）" },
        clear: { type: "boolean", description: "true 时清空 allowlist" },
      },
    },
    handle: async ({ user_id, clear }) => {
      const state = updateState((s) => {
        if (!Array.isArray(s.allowFrom)) s.allowFrom = [];
        if (clear) s.allowFrom = [];
        else if (user_id && !s.allowFrom.includes(user_id)) s.allowFrom.push(user_id);
        return s;
      });
      return ok({ allow_from: state.allowFrom });
    },
  },
  feishu_uninstall: {
    description:
      "完整卸载飞书渠道：停止 monitor、删除状态与插件目录；返回 platform_cleanup 与 dedicated_assistants_sidebar_delete。",
    inputSchema: { type: "object", properties: {} },
    handle: async () => ok(uninstallFeishu()),
  },
};

const TOOL_LIST = Object.entries(tools).map(([name, t]) => ({
  name,
  description: t.description,
  inputSchema: t.inputSchema,
}));

async function dispatch(name, args) {
  const tool = tools[name];
  if (!tool) return fail(`未知工具: ${name}`);
  try {
    return await tool.handle(args || {});
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

function writeMessage(msg) {
  const json = JSON.stringify(msg);
  fs.writeSync(1, `${json}\n`);
  try {
    fs.appendFileSync(
      "/workspace/.grok-feishu/mcp-host.log",
      `${new Date().toISOString()} out ${json.slice(0, 200)}\n`,
    );
  } catch {
    /* ignore */
  }
}

async function onRpc(msg) {
  try {
    fs.appendFileSync(
      "/workspace/.grok-feishu/mcp-host.log",
      `${new Date().toISOString()} in ${JSON.stringify({ id: msg.id, method: msg.method }).slice(0, 300)}\n`,
    );
  } catch {
    /* ignore */
  }
  const { id, method, params } = msg;
  if (method === "initialize") {
    touchConnectorActive();
    if (isConfigured()) ensureMonitor();
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "grok-feishu", version: "1.0.0" },
      },
    };
  }
  if (method === "notifications/initialized" || method === "initialized") return null;
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") {
    touchConnectorActive();
    return { jsonrpc: "2.0", id, result: { tools: TOOL_LIST } };
  }
  if (method === "tools/call") {
    touchConnectorActive();
    const result = await dispatch(params?.name, params?.arguments);
    return { jsonrpc: "2.0", id, result };
  }
  if (id === undefined) return null;
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

function startMcp() {
  registerShutdownCleanup();
  if (isConfigured()) ensureMonitor();
  let buf = Buffer.alloc(0);
  process.stdin.on("data", async (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        const nl = buf.indexOf("\n");
        if (nl !== -1) {
          const line = buf.slice(0, nl).toString("utf8").trim();
          buf = buf.slice(nl + 1);
          if (line.startsWith("{")) {
            try {
              const reply = await onRpc(JSON.parse(line));
              if (reply) writeMessage(reply);
            } catch (err) {
              writeMessage({
                jsonrpc: "2.0",
                id: null,
                error: { code: -32700, message: String(err) },
              });
            }
            continue;
          }
        }
        break;
      }
      const header = buf.slice(0, headerEnd).toString("utf8");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        buf = buf.slice(headerEnd + 4);
        continue;
      }
      const len = Number(match[1]);
      const start = headerEnd + 4;
      if (buf.length < start + len) break;
      const body = buf.slice(start, start + len).toString("utf8");
      buf = buf.slice(start + len);
      try {
        const reply = await onRpc(JSON.parse(body));
        if (reply) writeMessage(reply);
      } catch (err) {
        writeMessage({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: String(err) },
        });
      }
    }
  });
}

async function wakeAgent(messages, log) {
  if (!messages.length) return;
  const cfg = loadWake();
  if (!cfg) {
    log("wake skipped: no wake config");
    return;
  }
  const state = loadState();
  // Feishu-style: POST full event payload (first message) plus batch meta.
  // Also compatible with install skill that then calls feishu_inbox.
  const body = {
    source: "grok-feishu",
    count: messages.length,
    app_id: state.appId || "",
    dedicated_assistant_id: state.dedicatedAssistant?.id || "",
    dedicated_assistant_name: state.dedicatedAssistant?.name || "",
    message_ids: messages.map((m) => m.message_id),
    sender_ids: messages.map((m) => m.sender_id),
    // Direct payload for the newest event (bridge-compatible)
    ...messages[0],
    events: messages,
  };
  try {
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    log(`wake ${res.status} ${text.slice(0, 180)}`);
  } catch (err) {
    log(`wake error ${err instanceof Error ? err.message : String(err)}`);
  }
}

function eventTooOld(ev) {
  const ct = Number(ev.create_time || ev.timestamp || 0);
  if (!ct) return false;
  // Feishu create_time is often ms since epoch
  const ms = ct > 1e12 ? ct : ct * 1000;
  return Date.now() - ms > MAX_EVENT_AGE_MS;
}

async function handleEventLine(line, log) {
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    log(`skip non-json: ${line.slice(0, 80)}`);
    return;
  }
  const msg = normalizeEvent(raw);
  if (!msg?.message_id) {
    log("skip event without message_id");
    return;
  }
  if (isProcessed(msg.message_id)) {
    log(`skip-processed ${msg.message_id}`);
    return;
  }
  if (eventTooOld(raw)) {
    log(`skip-old ${msg.message_id}`);
    return;
  }
  const state = loadState();
  if (!isAllowed(state, msg.sender_id)) {
    log(`skip-allowlist ${msg.sender_id}`);
    return;
  }
  appendInbox([msg]);
  markProcessed(msg.message_id);
  log(`inbox +1 ${msg.message_id} from=${msg.sender_id}`);
  await wakeAgent([msg], log);
}

async function runMonitor() {
  const logStream = fs.createWriteStream(paths().log, { flags: "a" });
  const log = (line) => {
    logStream.write(`${new Date().toISOString()} ${line}\n`);
  };
  log("monitor start");
  writePid(process.pid);

  let child = null;
  let stopping = false;
  let restartDelay = 2000;

  const onExit = () => {
    stopping = true;
    try {
      if (child && !child.killed) child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    clearPid();
    process.exit(0);
  };
  process.on("SIGTERM", onExit);
  process.on("SIGINT", onExit);

  const loop = () => {
    if (stopping) return;
    if (connectorAbandoned()) {
      log("connector removed, running uninstall");
      runUninstall();
      process.exit(0);
    }
    if (!isConfigured()) {
      log("not configured, stopping");
      clearPid();
      process.exit(0);
    }

    child = spawnEventConsume({
      log,
      onLine: (line) => {
        handleEventLine(line, log).catch((err) => {
          log(`handle error ${err instanceof Error ? err.message : String(err)}`);
        });
      },
      onExit: (code, signal) => {
        log(`lark-cli exited code=${code} signal=${signal}`);
        if (stopping) return;
        setTimeout(() => {
          restartDelay = Math.min(restartDelay * 1.5, 30_000);
          loop();
        }, restartDelay);
      },
    });
    // Reset backoff after a successful spawn
    restartDelay = 2000;
  };

  loop();
}

if (process.argv.includes("--monitor")) {
  runMonitor();
} else if (process.argv.includes("--ensure-monitor")) {
  process.stdout.write(`${JSON.stringify(ensureMonitor())}\n`);
} else if (process.argv.includes("--list-tools")) {
  process.stdout.write(`${JSON.stringify(TOOL_LIST, null, 2)}\n`);
} else if (process.argv.includes("--uninstall")) {
  process.stdout.write(
    `${JSON.stringify(runUninstall({ deferPluginRemoval: false }), null, 2)}\n`,
  );
} else {
  startMcp();
}
