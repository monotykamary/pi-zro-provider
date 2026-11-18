import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { updateSettingsFile } from "../settings-file.ts";

const exec = promisify(execFile);
const moduleUrl = new URL("../settings-file.ts", import.meta.url).href;

function scratch() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-settings-"));
  return { directory, file: path.join(directory, "settings.json"), clean: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

test("independent processes merge changes into the same settings document", async () => {
  const { directory, file, clean } = scratch();
  try {
    const long = "x".repeat(64 * 1024);
    updateSettingsFile(file, () => ({ untouched: long }));
    const script = `
      import { updateSettingsFile } from ${JSON.stringify(moduleUrl)};
      const [file, field] = process.argv.slice(1);
      updateSettingsFile(file, current => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        return { ...current, [field]: true };
      });
    `;
    const commands = ["session", "account", "glyphs"].map((field) =>
      exec(process.execPath, ["--input-type=module", "--eval", script, file, field], { timeout: 3000 }),
    );
    const results = await Promise.allSettled(commands);
    for (const result of results) if (result.status === "rejected") throw result.reason;
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { untouched: long, session: true, account: true, glyphs: true });
    assert.deepEqual(fs.readdirSync(directory), ["settings.json"]);
  } finally {
    clean();
  }
});

test("an open reader keeps its old snapshot and a symlink still points at the updated target", { skip: process.platform === "win32" }, () => {
  const { directory, file, clean } = scratch();
  try {
    fs.writeFileSync(file, JSON.stringify({ old: "x".repeat(4_096) }));
    fs.chmodSync(file, 0o640);
    const alias = path.join(directory, "alias.json");
    fs.symlinkSync("settings.json", alias);
    const fd = fs.openSync(file, "r");
    try {
      updateSettingsFile(alias, () => ({ next: true }));
      assert.equal(JSON.parse(fs.readFileSync(fd, "utf8")).old.length, 4_096);
    } finally {
      fs.closeSync(fd);
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(alias, "utf8")), { next: true });
    assert.equal(fs.readlinkSync(alias), "settings.json");
    assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  } finally {
    clean();
  }
});

test("invalid existing JSON is not overwritten and the lock is released", () => {
  const { directory, file, clean } = scratch();
  try {
    fs.writeFileSync(file, "{partial");
    assert.throws(() => updateSettingsFile(file, () => ({ next: true })), SyntaxError);
    assert.equal(fs.readFileSync(file, "utf8"), "{partial");
    assert.deepEqual(fs.readdirSync(directory), ["settings.json"]);
    fs.writeFileSync(file, "{}");
    assert.deepEqual(updateSettingsFile(file, () => ({ next: true })), { next: true });
  } finally {
    clean();
  }
});

test("the status command preserves settings added since this Pi instance started", async () => {
  const { directory, clean } = scratch();
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  try {
    vi.resetModules();
    const { default: extension } = await import("../index.ts");
    const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
    extension({
      registerCommand: (name, command) => commands.set(name, command),
      registerProvider: () => {},
      registerEntryRenderer: () => {},
      on: () => {},
    } as Pick<ExtensionAPI, "registerCommand" | "registerProvider" | "registerEntryRenderer" | "on"> as ExtensionAPI);
    const file = path.join(directory, "extensions", "zro.json");
    const afterStartup = { session: "off", extra: "keep" };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(afterStartup));
    const command = commands.get("zro-status");
    assert.ok(command);
    const noop = () => {};
    const context = { hasUI: false, ui: { notify: noop, setStatus: noop, setWidget: noop } } as unknown as ExtensionCommandContext;
    await command.handler("glyphs ascii", context);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { ...afterStartup, glyphs: "ascii" });
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
    clean();
  }
});