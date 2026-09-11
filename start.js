const path = require("path");
const fs = require("fs");
const express = require("express");

const originalExpress = express;
const originalStatic = express.static;
const usageFile = process.env.USAGE_FILE || path.join(__dirname, "llm-usage.json");

function loadUsageRows() {
  try {
    const rows = JSON.parse(fs.readFileSync(usageFile, "utf8"));
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}
function errorStatsCutoff(range) {
  const now = Date.now();
  if (range === "today") {
    const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime();
  }
  const ms = ({ "4h": 4, "12h": 12, "24h": 24, "72h": 72, "7d": 168 }[range] || 24) * 3600e3;
  return now - ms;
}
function isErrorStatus(status) {
  const n = Number(status);
  return !Number.isFinite(n) || n < 200 || n >= 400;
}
function filterRows(range) {
  const cutoff = errorStatsCutoff(range);
  return loadUsageRows().filter((row) => {
    const at = Date.parse(row.at || "");
    return Number.isFinite(at) && at >= cutoff;
  });
}
function errorStatsSummary(rows) {
  let total = 0, errors = 0;
  for (const row of rows) { total += 1; if (isErrorStatus(row.status)) errors += 1; }
  return { total, errors, rate: total ? errors / total * 100 : 0 };
}
function errorStatsByModel(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const model = row.public_model || "(unknown)";
    const item = grouped.get(model) || { model, total: 0, errors: 0 };
    item.total += 1;
    if (isErrorStatus(row.status)) item.errors += 1;
    grouped.set(model, item);
  }
  return [...grouped.values()]
    .map((item) => ({ ...item, rate: item.total ? item.errors / item.total * 100 : 0 }))
    .sort((a, b) => b.errors - a.errors || b.total - a.total);
}
function errorStatsTimeline(rows, hours = 24) {
  const end = Date.now();
  const start = end - hours * 3600e3;
  const buckets = Array.from({ length: hours }, (_, i) => ({ at: start + i * 3600e3, total: 0, errors: 0 }));
  for (const row of rows) {
    const at = Date.parse(row.at || "");
    if (!Number.isFinite(at) || at < start || at > end) continue;
    const index = Math.min(hours - 1, Math.max(0, Math.floor((at - start) / 3600e3)));
    buckets[index].total += 1;
    if (isErrorStatus(row.status)) buckets[index].errors += 1;
  }
  return buckets.map((bucket) => ({ ...bucket, rate: bucket.total ? bucket.errors / bucket.total * 100 : 0 }));
}

function patchedExpress(...args) {
  const app = originalExpress(...args);
  const distDir = path.join(__dirname, "dist");
  app.use(originalStatic(distDir, { index: false }));

  app.get("/api/error-stats/summary", (req, res) => {
    const rows = filterRows(String(req.query.range || "24h"));
    res.json(errorStatsSummary(rows));
  });
  app.get("/api/error-stats/models", (req, res) => {
    const rows = filterRows(String(req.query.range || "24h"));
    res.json({ models: errorStatsByModel(rows) });
  });
  app.get("/api/error-stats/timeline", (req, res) => {
    const hours = Math.min(168, Math.max(1, Number(req.query.hours) || 24));
    const rows = filterRows(hours > 24 ? "7d" : "24h");
    res.json({ hours, points: errorStatsTimeline(rows, hours) });
  });

  return app;
}

Object.assign(patchedExpress, originalExpress);
patchedExpress.static = originalStatic;
require.cache[require.resolve("express")].exports = patchedExpress;

require("./server.js");
