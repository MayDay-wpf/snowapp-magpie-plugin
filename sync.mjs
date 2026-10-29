// Bun-side sync for the Snow App magpie agent.
//
// magpie's agent runtime has no file system or database access, so agent.mjs
// only writes ~/.snowapp/magpie-agent.json. This module runs in magpie's
// ordinary Bun plugin host (index.mjs starts it) and mirrors that file into
// Snow App's api_configs table.
//
// The first connection backs up the profile magpie is about to use (and the
// active profile at that moment). Disconnecting restores both, so the user's
// own Snow App setup is never permanently replaced.

import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const PROFILE_NAME = "magpie-agent";
export const DISPLAY_NAME = "Magpie (Agent)";
export const CONFIG_NAME = "magpie-agent.json";
export const STATE_NAME = "magpie-agent-state.json";
export const DB_NAME = "snowapp.db";

export function paths() {
  const dir = process.env.SNOWAPP_MAGPIE_HOME || join(homedir(), ".snowapp");
  return {
    dir,
    config: join(dir, CONFIG_NAME),
    state: join(dir, STATE_NAME),
    db: join(dir, DB_NAME),
  };
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    renameSync(tmp, file);
  } catch {
    // Windows cannot replace an existing file with rename(); retry once.
    try {
      unlinkSync(file);
    } catch {
      // The file may not exist yet.
    }
    renameSync(tmp, file);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function positiveInt(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function normalizeV1(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";
  const trimmed = raw.replace(/\/+$/, "");
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function connectionOf(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const magpie =
    config.magpie && typeof config.magpie === "object" && !Array.isArray(config.magpie)
      ? config.magpie
      : {};
  const model = typeof config.model === "string" ? config.model.trim() : "";
  const v1 = normalizeV1(magpie.v1);
  const key = typeof magpie.key === "string" ? magpie.key.trim() : "";
  if (!model || !v1 || !key) return null;
  const profile =
    typeof magpie.profile === "string" && magpie.profile.trim()
      ? magpie.profile.trim()
      : PROFILE_NAME;
  return {
    model,
    v1,
    key,
    profile,
    name: typeof magpie.name === "string" ? magpie.name : "",
    context: positiveInt(magpie.context),
    output: positiveInt(magpie.output),
    images: magpie.images === true,
  };
}

function signatureOf(conn) {
  return JSON.stringify([
    conn.profile,
    conn.model,
    conn.v1,
    conn.key,
    conn.context,
    conn.output,
    conn.images,
  ]);
}

function pick(value, fallback) {
  return value === undefined || value === null ? fallback : value;
}

function buildConfigJson(existing, conn) {
  let root = {};
  if (existing && typeof existing.config_json === "string" && existing.config_json.trim()) {
    try {
      const parsed = JSON.parse(existing.config_json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        root = parsed;
      }
    } catch {
      // A broken config_json is replaced, not carried forward.
    }
  }
  const existingSnowcfg =
    root.snowcfg && typeof root.snowcfg === "object" && !Array.isArray(root.snowcfg)
      ? root.snowcfg
      : {};
  const snowcfg = { ...existingSnowcfg };
  snowcfg.baseUrl = conn.v1;
  snowcfg.baseUrlMode = "custom";
  snowcfg.apiKey = conn.key;
  snowcfg.requestMethod = "chat";
  snowcfg.advancedModel = conn.model;
  snowcfg.basicModel = conn.model;
  snowcfg.supportsVision = conn.images;
  snowcfg.visionBaseUrl = "";
  snowcfg.visionBaseUrlMode = "auto";
  snowcfg.visionApiKey = "";
  snowcfg.visionRequestMethod = "chat";
  snowcfg.visionModel = "";
  if (conn.context) {
    snowcfg.maxContextTokens = conn.context;
  } else {
    delete snowcfg.maxContextTokens;
  }
  if (conn.output) {
    snowcfg.maxTokens = conn.output;
  } else {
    delete snowcfg.maxTokens;
  }
  const streamIdleTimeoutSec = existing ? existing.stream_idle_timeout_sec : null;
  if (streamIdleTimeoutSec) {
    snowcfg.streamIdleTimeoutSec = streamIdleTimeoutSec;
  } else {
    delete snowcfg.streamIdleTimeoutSec;
  }
  snowcfg.enableAutoCompress = existing ? Boolean(pick(existing.enable_auto_compress, 1)) : true;
  const autoCompressThreshold = existing ? existing.auto_compress_threshold : null;
  if (autoCompressThreshold) {
    snowcfg.autoCompressThreshold = autoCompressThreshold;
  } else {
    delete snowcfg.autoCompressThreshold;
  }
  snowcfg.maxRetries = existing ? pick(existing.max_retries, 5) : 5;
  snowcfg.retryDelayMs = existing ? pick(existing.retry_base_delay_ms, 3000) : 3000;
  snowcfg.partialRetryMaxChars = existing
    ? pick(existing.partial_retry_max_chars, 1000)
    : 1000;
  snowcfg.systemPromptIdsJson = existing ? pick(existing.system_prompt_ids_json, "") : "";
  snowcfg.customHeaderSchemeId = existing ? pick(existing.custom_header_scheme_id, "") : "";
  snowcfg.source = "magpie-agent";
  root.snowcfg = snowcfg;
  return JSON.stringify(root);
}

function rowFor(conn, existing, columns, nextSortOrder) {
  const row = {
    id: existing && existing.id ? existing.id : randomUUID(),
    profile_name: conn.profile,
    display_name: DISPLAY_NAME,
    is_active: 1,
    base_url: conn.v1,
    base_url_mode: "custom",
    api_key: conn.key,
    request_method: "chat",
    advanced_model: conn.model,
    basic_model: conn.model,
    supports_vision: conn.images ? 1 : 0,
    vision_base_url: "",
    vision_base_url_mode: "auto",
    vision_api_key: "",
    vision_request_method: "chat",
    vision_model: "",
    max_context_tokens: conn.context,
    max_tokens: conn.output,
    stream_idle_timeout_sec: existing ? existing.stream_idle_timeout_sec : null,
    enable_auto_compress: existing ? pick(existing.enable_auto_compress, 1) : 1,
    auto_compress_threshold: existing ? existing.auto_compress_threshold : null,
    max_retries: existing ? pick(existing.max_retries, 5) : 5,
    retry_base_delay_ms: existing ? pick(existing.retry_base_delay_ms, 3000) : 3000,
    partial_retry_max_chars: existing ? pick(existing.partial_retry_max_chars, 1000) : 1000,
    system_prompt_ids_json: existing ? pick(existing.system_prompt_ids_json, "") : "",
    custom_header_scheme_id: existing ? pick(existing.custom_header_scheme_id, "") : "",
    config_json: buildConfigJson(existing, conn),
    source: "magpie-agent",
    sort_order: existing ? pick(existing.sort_order, nextSortOrder) : nextSortOrder,
  };
  for (const key of Object.keys(row)) {
    if (!columns.has(key)) delete row[key];
  }
  return row;
}

let DatabaseCtor = null;

async function openDatabase() {
  const p = paths();
  if (!existsSync(p.db)) return null;
  if (!DatabaseCtor) {
    const mod = await import("bun:sqlite");
    DatabaseCtor = mod.Database;
  }
  const db = new DatabaseCtor(p.db);
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

function columnsOf(db) {
  return new Set(
    db
      .query("PRAGMA table_info(api_configs)")
      .all()
      .map((row) => row.name),
  );
}

async function applyConnection(conn) {
  const db = await openDatabase();
  if (!db) return { ok: false, reason: "Snow App database not found" };
  try {
    const columns = columnsOf(db);
    if (!columns.has("profile_name")) {
      return { ok: false, reason: "Snow App database has no api_configs table" };
    }
    const existing =
      db.query("SELECT * FROM api_configs WHERE profile_name = ?").get(conn.profile) ?? null;
    const ours = existing && existing.source === "magpie-agent";
    let state = readJson(paths().state);
    if (!state || state.version !== 1 || state.profile !== conn.profile) {
      const active = db
        .query("SELECT profile_name FROM api_configs WHERE is_active = 1 ORDER BY sort_order LIMIT 1")
        .get();
      state = {
        version: 1,
        profile: conn.profile,
        createdAt: new Date().toISOString(),
        previous: existing && !ours ? clone(existing) : null,
        previousActive: active ? active.profile_name : null,
      };
      writeJsonAtomic(paths().state, state);
    }

    const nextSortOrder =
      (db.query("SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM api_configs").get() || {})
        .next || 1;
    const row = rowFor(conn, existing, columns, nextSortOrder);
    const updateKeys = Object.keys(row).filter((key) => key !== "id" && key !== "profile_name");

    const tx = db.transaction(() => {
      db.query("UPDATE api_configs SET is_active = 0 WHERE is_active = 1").run();
      if (existing) {
        const sets = updateKeys.map((key) => `${key} = ?`).join(", ");
        db.query(
          `UPDATE api_configs SET ${sets}, updated_at = datetime('now','localtime') WHERE id = ?`,
        ).run(...updateKeys.map((key) => row[key]), existing.id);
      } else {
        const keys = ["id", "profile_name", ...updateKeys];
        const placeholders = keys.map(() => "?").join(", ");
        db.query(
          `INSERT INTO api_configs (${keys.join(", ")}, created_at, updated_at) VALUES (${placeholders}, datetime('now','localtime'), datetime('now','localtime'))`,
        ).run(...keys.map((key) => row[key]));
      }
    });
    tx();

    state.applied = {
      model: conn.model,
      v1: conn.v1,
      at: new Date().toISOString(),
    };
    writeJsonAtomic(paths().state, state);
    return { ok: true, created: !existing };
  } finally {
    db.close();
  }
}

async function restoreConnection() {
  const p = paths();
  const state = readJson(p.state);
  if (!state) return { ok: true, restored: false };
  const db = await openDatabase();
  if (!db) return { ok: false, reason: "Snow App database not found" };
  try {
    const columns = columnsOf(db);
    if (!columns.has("profile_name")) {
      return { ok: false, reason: "Snow App database has no api_configs table" };
    }
    const tx = db.transaction(() => {
      const prev = state.previous;
      if (prev && prev.id) {
        const exists = db.query("SELECT 1 AS ok FROM api_configs WHERE id = ?").get(prev.id);
        const keys = Object.keys(prev).filter((key) => key !== "id" && columns.has(key));
        if (exists) {
          const sets = keys.map((key) => `${key} = ?`).join(", ");
          db.query(
            `UPDATE api_configs SET ${sets}, updated_at = datetime('now','localtime') WHERE id = ?`,
          ).run(...keys.map((key) => prev[key]), prev.id);
        } else {
          const insertKeys = ["id", ...keys];
          db.query(
            `INSERT INTO api_configs (${insertKeys.join(", ")}) VALUES (${insertKeys.map(() => "?").join(", ")})`,
          ).run(...insertKeys.map((key) => (key === "id" ? prev.id : prev[key])));
        }
      } else {
        db.query("DELETE FROM api_configs WHERE profile_name = ? AND source = 'magpie-agent'").run(
          state.profile || PROFILE_NAME,
        );
      }

      db.query("UPDATE api_configs SET is_active = 0 WHERE is_active = 1").run();
      let activated = false;
      if (state.previousActive) {
        const result = db
          .query("UPDATE api_configs SET is_active = 1 WHERE profile_name = ?")
          .run(state.previousActive);
        activated = Number(result.changes || 0) > 0;
      }
      if (!activated) {
        const first = db
          .query("SELECT id FROM api_configs ORDER BY sort_order, profile_name LIMIT 1")
          .get();
        if (first) {
          db.query("UPDATE api_configs SET is_active = 1 WHERE id = ?").run(first.id);
        }
      }
    });
    tx();
    try {
      unlinkSync(p.state);
    } catch {
      // Already gone.
    }
    return { ok: true, restored: true };
  } finally {
    db.close();
  }
}

let lastApplied = "";
let disconnectedTicks = 0;
let missingTicks = 0;

export function resetSyncState() {
  lastApplied = "";
  disconnectedTicks = 0;
  missingTicks = 0;
}

export async function syncOnce() {
  const p = paths();
  if (!existsSync(p.config)) {
    missingTicks += 1;
    if (missingTicks >= 2 && readJson(p.state)) {
      const result = await restoreConnection();
      if (result.ok) {
        resetSyncState();
        return { action: "restored", result };
      }
      return { action: "idle", result };
    }
    return { action: "idle" };
  }

  missingTicks = 0;
  let raw;
  try {
    raw = readFileSync(p.config, "utf8");
  } catch {
    return { action: "idle" };
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    return { action: "idle", reason: "partial-write" };
  }
  const conn = connectionOf(config);
  if (!conn) {
    disconnectedTicks += 1;
    if (disconnectedTicks >= 2 && readJson(p.state)) {
      const result = await restoreConnection();
      if (result.ok) {
        resetSyncState();
        return { action: "restored", result };
      }
      return { action: "idle", result };
    }
    return { action: "idle", reason: "not-connected" };
  }

  disconnectedTicks = 0;
  const signature = signatureOf(conn);
  if (signature === lastApplied) return { action: "idle", reason: "unchanged" };
  const result = await applyConnection(conn);
  if (result.ok) {
    lastApplied = signature;
    return { action: result.created ? "created" : "updated", result };
  }
  return { action: "error", result };
}

let timer = null;

export function startSync() {
  if (timer) return timer;
  let lastNotice = "";
  const note = (message) => {
    if (message === lastNotice) return;
    lastNotice = message;
    console.warn(`[snowapp-magpie] ${message}`);
  };
  const run = () => {
    syncOnce()
      .then((result) => {
        if (result.action === "created" || result.action === "updated") {
          lastNotice = "";
          console.log(`[snowapp-magpie] ${result.action} Snow App profile`);
        } else if (result.action === "restored") {
          lastNotice = "";
          console.log("[snowapp-magpie] restored Snow App profile");
        } else if (result.action === "error") {
          note(result.result?.reason || "sync failed");
        }
      })
      .catch((error) => {
        note(String(error?.message || error));
      });
  };
  run();
  timer = setInterval(run, 1000);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

export function stopSync() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
