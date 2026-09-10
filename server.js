const express = require("express");
const http = require("http");
const https = require("https");
const { SocksProxyAgent } = require("socks-proxy-agent");

// =========================
// 配置
// =========================

const LISTEN_HOST = process.env.LISTEN_HOST || "127.0.0.1";
const LISTEN_PORT = Number(process.env.LISTEN_PORT || 8080);

// 例如：
// socks5://127.0.0.1:1080
// socks5://user:password@127.0.0.1:1080
const SOCKS5_PROXY =
  process.env.SOCKS5_PROXY || "socks5://127.0.0.1:1080";

// 你的 Chat Completions API
// 例如：
// https://api.openai.com/v1/chat/completions
// https://your-server.example.com/v1/chat/completions
const TARGET_URL =
  process.env.TARGET_URL ||
  "https://api.openai.com/v1/chat/completions";

// =========================
// 初始化
// =========================

const app = express();

// 不限制 body 大小，避免请求被截断
app.use(
  express.raw({
    type: "*/*",
    limit: "50mb",
  })
);

const target = new URL(TARGET_URL);
const agent = new SocksProxyAgent(SOCKS5_PROXY);

const transport = target.protocol === "https:" ? https : http;

// =========================
// 健康检查
// =========================

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    target: TARGET_URL,
    socks5: SOCKS5_PROXY.replace(
      /\/\/([^:@]+):([^@]+)@/,
      "//***:***@"
    ),
  });
});

// =========================
// Chat Completions
// =========================

app.all("/v1/chat/completions", (req, res) => {
  const headers = {
    ...req.headers,
    host: target.host,
  };

  // Authorization 会从 req.headers 自动转发
  //
  // 例如：
  // Authorization: Bearer sk-xxxx
  //
  // 不需要在这里单独写死。

  // 本地请求的 connection 等 hop-by-hop header
  // 不应该继续转发
  delete headers.connection;
  delete headers["proxy-connection"];
  delete headers["keep-alive"];
  delete headers["transfer-encoding"];

  const requestOptions = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === "https:" ? 443 : 80),
    method: req.method,
    path: target.pathname + target.search,
    headers,
    agent,
  };

  console.log(
    `${new Date().toISOString()} ${req.method} ${req.originalUrl} -> ${TARGET_URL}`
  );

  const proxyReq = transport.request(requestOptions, (proxyRes) => {
    // 把上游 HTTP 状态码和 headers 原样返回
    res.status(proxyRes.statusCode || 502);

    for (const [key, value] of Object.entries(proxyRes.headers)) {
      // 某些 hop-by-hop header 不应该返回给客户端
      if (
        key.toLowerCase() === "connection" ||
        key.toLowerCase() === "transfer-encoding" ||
        key.toLowerCase() === "keep-alive"
      ) {
        continue;
      }

      if (value !== undefined) {
        res.setHeader(key, value);
      }
    }

    // 流式转发
    proxyRes.pipe(res);

    proxyRes.on("error", (err) => {
      console.error("Upstream response error:", err);
      if (!res.headersSent) {
        res.status(502).json({
          error: {
            message: "Upstream response error",
            type: "proxy_error",
          },
        });
      } else {
        res.destroy(err);
      }
    });
  });

  proxyReq.setTimeout(120000, () => {
    console.error("Upstream request timeout");

    proxyReq.destroy(
      new Error("Upstream request timeout")
    );
  });

  proxyReq.on("error", (err) => {
    console.error("Proxy request error:", err.message);

    if (!res.headersSent) {
      res.status(502).json({
        error: {
          message: err.message,
          type: "proxy_error",
        },
      });
    } else {
      res.destroy(err);
    }
  });

  // express.raw() 已经把完整 body 放在 req.body
  if (req.body && req.body.length > 0) {
    proxyReq.write(req.body);
  }

  proxyReq.end();
});

// =========================
// 404
// =========================

app.use((req, res) => {
  res.status(404).json({
    error: {
      message: "Not found",
      type: "proxy_error",
    },
  });
});

// =========================
// 启动
// =========================

const server = app.listen(
  LISTEN_PORT,
  LISTEN_HOST,
  () => {
    console.log("");
    console.log("LLM SOCKS5 proxy started");
    console.log("--------------------------------");
    console.log(`Local:  http://${LISTEN_HOST}:${LISTEN_PORT}`);
    console.log(`Target: ${TARGET_URL}`);
    console.log(
      `SOCKS5: ${SOCKS5_PROXY.replace(
        /\/\/([^:@]+):([^@]+)@/,
        "//***:***@"
      )}`
    );
    console.log("--------------------------------");
    console.log("");
  }
);

// 优雅退出
function shutdown() {
  console.log("\nShutting down...");
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
