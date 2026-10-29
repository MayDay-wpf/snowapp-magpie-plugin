import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  resetSyncState,
  syncOnce,
  paths,
  PROFILE_NAME,
  STATE_NAME,
  CONFIG_NAME,
  DB_NAME,
} from "../sync.mjs";

const SCHEMA = `
CREATE TABLE api_configs (
  id TEXT PRIMARY KEY NOT NULL,
  profile_name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  base_url TEXT NOT NULL DEFAULT '',
  base_url_mode TEXT NOT NULL DEFAULT 'auto',
  api_key TEXT NOT NULL DEFAULT '',
  request_method TEXT NOT NULL DEFAULT 'chat',
  advanced_model TEXT NOT NULL DEFAULT '',
  basic_model TEXT NOT NULL DEFAULT '',
  supports_vision INTEGER NOT NULL DEFAULT 1,
  vision_base_url TEXT NOT NULL DEFAULT '',
  vision_base_url_mode TEXT NOT NULL DEFAULT 'auto',
  vision_api_key TEXT NOT NULL DEFAULT '',
  vision_request_method TEXT NOT NULL DEFAULT 'chat',
  vision_model TEXT NOT NULL DEFAULT '',
  max_context_tokens INTEGER,
  max_tokens INTEGER,
  stream_idle_timeout_sec INTEGER,
  enable_auto_compress INTEGER NOT NULL DEFAULT 1,
  auto_compress_threshold INTEGER,
  max_retries INTEGER NOT NULL DEFAULT 5,
  retry_base_delay_ms INTEGER NOT NULL DEFAULT 3000,
  system_prompt_ids_json TEXT NOT NULL DEFAULT '',
  custom_header_scheme_id TEXT NOT NULL DEFAULT '',
  config_json TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  partial_retry_max_chars INTEGER NOT NULL DEFAULT 1000,
  sort_order INTEGER NOT NULL DEFAULT 0
);
`;

let dir;
let dbPath;
let previousHome;

function config(overrides = {}) {
  return {
    model: "openai/gpt-5",
    magpie: {
      v1: "http://127.0.0.1:3425/v1",
      url: "http://127.0.0.1:3425",
      key: "magpie-snowapp-test",
      model: "openai/gpt-5",
      name: "GPT-5",
      context: 400000,
      output: 128000,
      images: true,
      profile: "magpie-agent",
      ...overrides,
    },
    ...overrides,
  };
}

function seed(size = 2) {
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  const insert = db.query(
    `INSERT INTO api_configs
      (id, profile_name, display_name, is_active, base_url, base_url_mode, api_key,
       request_method, advanced_model, basic_model, supports_vision, config_json,
       source, sort_order)
     VALUES (?, ?, ?, ?, ?, 'auto', ?, 'chat', ?, ?, 1, ?, 'manual', ?)`,
  );
  insert.run("id-a", "alpha", "Alpha", 1, "https://alpha.example/v1", "sk-alpha", "a-1", "a-1", '{"snowcfg":{"chatThinking":{"enabled":true}}}', 1);
  if (size > 1) {
    insert.run("id-b", "beta", "Beta", 0, "https://beta.example/v1", "sk-beta", "b-1", "b-1", "{}", 2);
  }
  db.close();
}

function writeConfig(value) {
  writeFileSync(join(dir, CONFIG_NAME), typeof value === "string" ? value : JSON.stringify(value));
}

function readRow(name) {
  const db = new Database(dbPath, { readonly: true });
  const row = db.query("SELECT * FROM api_configs WHERE profile_name = ?").get(name) ?? null;
  db.close();
  return row;
}

function activeName() {
  const db = new Database(dbPath, { readonly: true });
  const row = db.query("SELECT profile_name FROM api_configs WHERE is_active = 1").get();
  db.close();
  return row ? row.profile_name : null;
}

beforeEach(() => {
  previousHome = process.env.SNOWAPP_MAGPIE_HOME;
  dir = mkdtempSync(join(tmpdir(), "snowapp-magpie-"));
  process.env.SNOWAPP_MAGPIE_HOME = dir;
  dbPath = join(dir, DB_NAME);
  process.env.SNOWAPP_DB_PATH = dbPath;
  resetSyncState();
});

afterEach(() => {
  delete process.env.SNOWAPP_DB_PATH;
  if (previousHome === undefined) delete process.env.SNOWAPP_MAGPIE_HOME;
  else process.env.SNOWAPP_MAGPIE_HOME = previousHome;
  rmSync(dir, { recursive: true, force: true });
  resetSyncState();
});

describe("snowapp magpie sync", () => {
  test("resolves Snow App's database beside the config directory", () => {
    expect(paths().db).toBe(join(dir, DB_NAME));
  });

  test("honours SNOWAPP_DB_PATH for a relocated database", () => {
    const relocated = join(dir, "relocated.db");
    process.env.SNOWAPP_DB_PATH = relocated;
    expect(paths().db).toBe(relocated);
  });

  test("creates the magpie-agent profile and activates it", async () => {
    seed();
    writeConfig(config());

    const result = await syncOnce();
    expect(result.action).toBe("created");

    const row = readRow(PROFILE_NAME);
    expect(row).not.toBeNull();
    expect(row.is_active).toBe(1);
    expect(row.base_url).toBe("http://127.0.0.1:3425/v1");
    expect(row.api_key).toBe("magpie-snowapp-test");
    expect(row.advanced_model).toBe("openai/gpt-5");
    expect(row.basic_model).toBe("openai/gpt-5");
    expect(row.supports_vision).toBe(1);
    expect(row.max_context_tokens).toBe(400000);
    expect(row.max_tokens).toBe(128000);
    expect(row.source).toBe("magpie-agent");
    expect(activeName()).toBe("magpie-agent");

    const json = JSON.parse(row.config_json);
    expect(json.snowcfg.baseUrl).toBe("http://127.0.0.1:3425/v1");
    expect(json.snowcfg.requestMethod).toBe("chat");
    expect(json.snowcfg.advancedModel).toBe("openai/gpt-5");
    expect(existsSync(join(dir, STATE_NAME))).toBe(true);
  });

  test("updates an existing magpie-agent profile instead of duplicating it", async () => {
    seed();
    writeConfig(config());
    await syncOnce();

    const next = config({ model: "anthropic/claude-sonnet-4-5" });
    writeConfig(next);
    const result = await syncOnce();
    expect(result.action).toBe("updated");

    const row = readRow(PROFILE_NAME);
    expect(row.advanced_model).toBe("anthropic/claude-sonnet-4-5");
    expect(row.basic_model).toBe("anthropic/claude-sonnet-4-5");
  });

  test("restores the previous active profile when disconnected", async () => {
    seed();
    writeConfig(config());
    await syncOnce();
    expect(activeName()).toBe("magpie-agent");

    writeConfig({ model: "openai/gpt-5", magpie: { v1: "http://127.0.0.1:3425/v1" } });
    const first = await syncOnce();
    expect(first.action).toBe("idle");
    const second = await syncOnce();
    expect(second.action).toBe("restored");

    expect(readRow(PROFILE_NAME)).toBeNull();
    expect(activeName()).toBe("alpha");
    expect(existsSync(join(dir, STATE_NAME))).toBe(false);
  });

  test("restores a user profile that had the same name", async () => {
    seed();
    const db = new Database(dbPath);
    db.query(
      `INSERT INTO api_configs
        (id, profile_name, display_name, is_active, base_url, base_url_mode, api_key,
         request_method, advanced_model, basic_model, supports_vision, config_json,
         source, sort_order)
       VALUES ('id-m', 'magpie-agent', 'My own agent', 0, 'https://mine.example/v1', 'auto', 'sk-mine',
               'responses', 'mine-1', 'mine-2', 0, '{"snowcfg":{"baseUrl":"https://mine.example/v1"}}',
               'manual', 3)`,
    ).run();
    db.close();

    writeConfig(config());
    await syncOnce();
    let row = readRow(PROFILE_NAME);
    expect(row.display_name).toBe("Magpie (Agent)");
    expect(row.base_url).toBe("http://127.0.0.1:3425/v1");

    writeConfig({});
    await syncOnce();
    await syncOnce();

    row = readRow(PROFILE_NAME);
    expect(row.display_name).toBe("My own agent");
    expect(row.base_url).toBe("https://mine.example/v1");
    expect(row.request_method).toBe("responses");
    expect(row.is_active).toBe(0);
  });

  test("waits for a partial write instead of restoring", async () => {
    seed();
    writeConfig(config());
    await syncOnce();

    writeConfig('{"model":"openai/gpt-5","magpie":{');
    expect((await syncOnce()).reason).toBe("partial-write");
    expect(readRow(PROFILE_NAME)).not.toBeNull();
    expect(activeName()).toBe("magpie-agent");
  });

  test("treats a missing config file as a disconnect after two ticks", async () => {
    seed();
    writeConfig(config());
    await syncOnce();

    rmSync(join(dir, CONFIG_NAME), { force: true });
    expect((await syncOnce()).action).toBe("idle");
    expect((await syncOnce()).action).toBe("restored");
    expect(readRow(PROFILE_NAME)).toBeNull();
    expect(activeName()).toBe("alpha");
  });

  test("does nothing when Snow App is not installed", async () => {
    rmSync(dbPath, { force: true });
    writeConfig(config());
    const result = await syncOnce();
    expect(result.action).toBe("error");
    expect(result.result.reason).toContain("database not found");
  });
});
