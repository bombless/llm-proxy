const express = require("express");
const { register } = require("./benchmark");
if (!express.application.__llmProxyBenchmarkPatched) {
  const originalListen = express.application.listen;
  express.application.listen = function (...args) {
    register(this);
    return originalListen.apply(this, args);
  };
  express.application.__llmProxyBenchmarkPatched = true;
}
