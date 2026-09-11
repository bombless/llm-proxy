const path = require("path");
const express = require("express");

const originalExpress = express;
const originalStatic = express.static;

function patchedExpress(...args) {
  const app = originalExpress(...args);
  const distDir = path.join(__dirname, "dist");
  app.use(originalStatic(distDir, { index: false }));
  return app;
}

Object.assign(patchedExpress, originalExpress);
patchedExpress.static = originalStatic;
require.cache[require.resolve("express")].exports = patchedExpress;

require("./server.js");
