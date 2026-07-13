#!/usr/bin/env node

"use strict";

const { closeSync, openSync, unlinkSync } = require("fs");
const { join, resolve } = require("path");
const Database = require("better-sqlite3");

const port = Number(process.env.PORT || 3000);
const configDir = resolve(process.env.COFORGE_CONFIG_DIR || "/var/lib/coforge");
const databasePath = resolve(process.env.DB_PATH || "/app/data/coal-demo.db");

async function main() {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid container port");

  const response = await fetch(`http://127.0.0.1:${port}/api/live`, {
    cache: "no-store",
    signal: AbortSignal.timeout(1_500),
  });
  if (!response.ok) throw new Error("Liveness endpoint failed");
  const payload = await response.json();
  if (payload?.status !== "live") throw new Error("Invalid liveness response");

  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    database.prepare("SELECT 1").get();
  } finally {
    database.close();
  }

  const probePath = join(configDir, `.healthcheck-${process.pid}`);
  let descriptor;
  try {
    descriptor = openSync(probePath, "wx", 0o600);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(probePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Container healthcheck failed");
  process.exit(1);
});
