/**
 * Quiet startup sync, end to end through the extension's real session_start
 * handler: the live /models catalog is fetched only with a key, only when the
 * disk cache is stale (or the key changed), only by one process at a time, and
 * never on the session_start critical path.
 *
 * Porting: only the "Provider specifics" block below differs between
 * pi-*-provider repos.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keyFingerprint, syncLockPath, syncMetaPath } from "../sync-policy";
import embeddedModels from "../models.json" with { type: "json" };

// ─── Provider specifics ───────────────────────────────────────────────────────
const PROVIDER_ID = "zro";
const LIVE_ONLY_ID = "live-only-test-model";
/** A minimal successful /api/cli/models response containing LIVE_ONLY_ID. */
const liveModelsResponse = () => Response.json({
  models: [{
    id: LIVE_ONLY_ID,
    displayName: "Live Only",
    contextWindow: 65536,
    maxOutputTokens: 8192,
    reasoning: { levels: [{ id: "high", piLevel: "high" }] },
  }],
});
/** Registrations when no live catalog lands: load + session_start's identity re-register. */
const REGISTRATIONS_WITHOUT_SYNC = 2;
/** Keep the real environment out: zro CLI credentials, env key, endpoint override. */
function stubProviderEnv(home: string): void {
  vi.stubEnv("XDG_CONFIG_HOME", path.join(home, "xdg"));
  vi.stubEnv("ZRO_API_KEY", "");
  vi.stubEnv("ZRO_ENDPOINT_ROOT", "");
}
// ──────────────────────────────────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000;
const KEY = "sk-quiet-sync-test";

let home: string;
let cachePath: string;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

function setupHome(): void {
  home = fs.mkdtempSync(path.join(os.tmpdir(), `pi-${PROVIDER_ID}-sync-`));
  cachePath = path.join(home, "cache", `${PROVIDER_ID}-models.json`);
  vi.stubEnv("PI_CODING_AGENT_DIR", home);
  vi.stubEnv("PI_PROVIDER_SYNC_TTL_MS", "");
  stubProviderEnv(home);
}

function writeCache(ageMs: number, models: unknown[] = embeddedModels, fingerprintKey: string | null = KEY): void {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(models));
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(cachePath, t, t);
  if (fingerprintKey !== null) {
    fs.writeFileSync(syncMetaPath(cachePath), JSON.stringify({ version: 1, keyFingerprint: keyFingerprint(fingerprintKey) }));
  }
}

function stubFetch(impl: (input?: any) => Promise<Response> = async () => liveModelsResponse()) {
  const fetch = vi.fn(impl);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/** pi's print-mode UI is a no-op; the extension renders through it unconditionally. */
const noopUi = { setStatus: () => {}, setWidget: () => {}, notify: () => {}, select: async () => undefined, theme: { fg: (_c: string, t: string) => t } };

/** Load the extension fresh (module-level cache paths read PI_CODING_AGENT_DIR). */
async function loadExtension() {
  vi.resetModules();
  const mod = await import("../index");
  const handlers = new Map<string, (...args: any[]) => any>();
  const registrations: Array<{ models: Array<{ id: string }> }> = [];
  mod.default({
    on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
    registerProvider: (_id: string, config: any) => registrations.push(config),
    registerCommand: () => {},
  } as any);
  const getApiKeyForProvider = vi.fn(async (): Promise<string | undefined> => KEY);
  // Print mode / child agent by default (no UI → no account prefetch).
  const startSession = (ctxOverrides: Record<string, unknown> = {}) => handlers.get("session_start")!(
    { type: "session_start" },
    { hasUI: false, ui: noopUi, modelRegistry: { getApiKeyForProvider }, ...ctxOverrides },
  );
  return { handlers, registrations, getApiKeyForProvider, startSession };
}

/** Let the fire-and-forget revalidation chain run to completion. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
const hasLiveModel = (config: { models: Array<{ id: string }> } | undefined) => !!config?.models.some((m) => m.id === LIVE_ONLY_ID);

describe("quiet startup sync", () => {
  it("skips the live fetch while the disk cache is fresher than the TTL", async () => {
    setupHome();
    writeCache(10 * 60 * 1000);
    const fetch = stubFetch();
    const ext = await loadExtension();
    await ext.startSession();
    await settle();
    expect(ext.getApiKeyForProvider).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(ext.registrations).toHaveLength(REGISTRATIONS_WITHOUT_SYNC);
  });

  it("revalidates a stale cache once, hot-swaps the catalog and rewrites the cache", async () => {
    setupHome();
    writeCache(2 * HOUR);
    const fetch = stubFetch();
    const ext = await loadExtension();
    await ext.startSession();
    await vi.waitFor(() => expect(hasLiveModel(ext.registrations.at(-1))).toBe(true));
    expect(fetch).toHaveBeenCalledOnce();
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    // Cache stays a plain JSON array so older extension versions still read it.
    expect(Array.isArray(cached)).toBe(true);
    expect(cached.some((m: { id: string }) => m.id === LIVE_ONLY_ID)).toBe(true);
    expect(Date.now() - fs.statSync(cachePath).mtimeMs).toBeLessThan(60_000);
    expect(fs.existsSync(syncLockPath(cachePath))).toBe(false);
    const meta = fs.readFileSync(syncMetaPath(cachePath), "utf8");
    expect(meta).not.toContain(KEY);
    expect(JSON.parse(meta).keyFingerprint).toBe(keyFingerprint(KEY));

    // A second session in the same process (/new) is now inside the TTL.
    await ext.startSession();
    await settle();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("never touches the network without an API key", async () => {
    setupHome();
    const fetch = stubFetch();
    const ext = await loadExtension();
    ext.getApiKeyForProvider.mockResolvedValue(undefined);
    await ext.startSession();
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.existsSync(syncLockPath(cachePath))).toBe(false);
    expect(ext.registrations).toHaveLength(REGISTRATIONS_WITHOUT_SYNC);
  });

  it("skips when another process holds the revalidation lock", async () => {
    setupHome();
    writeCache(2 * HOUR);
    fs.writeFileSync(syncLockPath(cachePath), JSON.stringify({ pid: 999999, token: "other-process" }));
    const fetch = stubFetch();
    const ext = await loadExtension();
    await ext.startSession();
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(syncLockPath(cachePath), "utf8")).token).toBe("other-process");
  });

  it("reclaims a stale lock left by a crashed process", async () => {
    setupHome();
    writeCache(2 * HOUR);
    const lockPath = syncLockPath(cachePath);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, token: "crashed" }));
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(lockPath, old, old);
    const fetch = stubFetch();
    const ext = await loadExtension();
    await ext.startSession();
    await vi.waitFor(() => expect(hasLiveModel(ext.registrations.at(-1))).toBe(true));
    expect(fetch).toHaveBeenCalledOnce();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("forces a revalidation when the API key changed, even inside the TTL", async () => {
    setupHome();
    writeCache(60 * 1000, embeddedModels, "previous-key");
    const fetch = stubFetch();
    const ext = await loadExtension();
    await ext.startSession();
    await vi.waitFor(() => expect(hasLiveModel(ext.registrations.at(-1))).toBe(true));
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("revalidates once when the cache predates the sync sidecar (older extension version)", async () => {
    setupHome();
    writeCache(60 * 1000, embeddedModels, null);
    const fetch = stubFetch();
    const ext = await loadExtension();
    expect(ext.registrations[0].models.length).toBeGreaterThan(0); // old cache is still served
    await ext.startSession();
    await vi.waitFor(() => expect(hasLiveModel(ext.registrations.at(-1))).toBe(true));
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not throw or fetch when the cache dir is unwritable", async () => {
    setupHome();
    fs.writeFileSync(path.join(home, "cache"), "a file where the cache dir should be");
    const fetch = stubFetch();
    const ext = await loadExtension();
    await expect(ext.startSession()).resolves.toBeUndefined();
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    expect(ext.registrations).toHaveLength(REGISTRATIONS_WITHOUT_SYNC);
  });

  it("does not await the network in session_start", async () => {
    setupHome();
    writeCache(2 * HOUR);
    let release!: () => void;
    const fetch = stubFetch(() => new Promise<Response>((resolve) => { release = () => resolve(liveModelsResponse()); }));
    const ext = await loadExtension();
    const outcome = await Promise.race([
      Promise.resolve(ext.startSession()).then(() => "returned"),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 1000)),
    ]);
    expect(outcome).toBe("returned");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    release();
    await vi.waitFor(() => expect(hasLiveModel(ext.registrations.at(-1))).toBe(true));
  });

  it("swallows API key resolution failures (no unhandled rejection)", async () => {
    setupHome();
    const fetch = stubFetch();
    const ext = await loadExtension();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      ext.getApiKeyForProvider.mockRejectedValue(new Error("keychain locked"));
      await ext.startSession();
      await settle();
      expect(unhandled).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("backs off after a failed fetch instead of retrying in every new process", async () => {
    setupHome();
    writeCache(2 * HOUR);
    const fetch = stubFetch(async () => new Response("unauthorized", { status: 401 }));
    let ext = await loadExtension();
    await ext.startSession();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await settle();
    ext = await loadExtension(); // next pi process
    await ext.startSession();
    await settle();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("adopts a cache refreshed by another process without fetching", async () => {
    setupHome();
    writeCache(30 * 60 * 1000);
    const fetch = stubFetch();
    const ext = await loadExtension();
    // Another pi process revalidated after this one started.
    const refreshed = [...embeddedModels, { ...embeddedModels[0], id: LIVE_ONLY_ID }];
    fs.writeFileSync(cachePath, JSON.stringify(refreshed));
    await ext.startSession();
    await vi.waitFor(() => expect(hasLiveModel(ext.registrations.at(-1))).toBe(true));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("PI_PROVIDER_SYNC_TTL_MS=0 revalidates on every session start", async () => {
    setupHome();
    vi.stubEnv("PI_PROVIDER_SYNC_TTL_MS", "0");
    writeCache(0);
    const fetch = stubFetch();
    const ext = await loadExtension();
    await ext.startSession();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  });
});

// ─── Zro specifics: CLI credentials and the account status prefetch ──────────

const ACCOUNT_STATUS = { billing: { totalRemaining: 12.34, plan: { name: "Pro" } }, activity30d: { requests: 7 } };

/** Interactive ctx with an active Zro model and a no-op UI. */
const interactiveCtx = () => ({
  hasUI: true,
  model: { provider: PROVIDER_ID, id: "glm-5.2" },
  ui: noopUi,
});

function writeCliCredentials(apiKey: string): void {
  const file = path.join(home, "xdg", "zro", "credentials.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ apiKey }));
}

/** Routes /api/cli/status vs /api/cli/models. */
function stubZroFetch() {
  return stubFetch(async (input?: any) => String(input).includes("/api/cli/status") ? Response.json(ACCOUNT_STATUS) : liveModelsResponse());
}
const statusCalls = (fetch: ReturnType<typeof stubFetch>) => fetch.mock.calls.filter(([url]) => String(url).includes("/api/cli/status")).length;
const modelCalls = (fetch: ReturnType<typeof stubFetch>) => fetch.mock.calls.filter(([url]) => String(url).includes("/api/cli/models")).length;

describe("quiet startup sync (zro)", () => {
  it("a new `zro login` (CLI credentials file) forces a revalidation inside the TTL", async () => {
    setupHome();
    writeCliCredentials("cli-key-1");
    writeCache(60 * 1000, embeddedModels, "cli-key-1");
    const fetch = stubFetch();
    let ext = await loadExtension();
    ext.getApiKeyForProvider.mockResolvedValue(undefined);
    await ext.startSession();
    await settle();
    expect(fetch).not.toHaveBeenCalled();

    writeCliCredentials("cli-key-2");
    ext = await loadExtension(); // next pi process
    ext.getApiKeyForProvider.mockResolvedValue(undefined);
    await ext.startSession();
    await vi.waitFor(() => expect(hasLiveModel(ext.registrations.at(-1))).toBe(true));
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer cli-key-2");
  });

  it("skips the account prefetch without a UI (print mode, child agents)", async () => {
    setupHome();
    writeCache(10 * 60 * 1000);
    const fetch = stubZroFetch();
    const ext = await loadExtension();
    await ext.startSession({ ...interactiveCtx(), hasUI: false });
    await settle();
    expect(statusCalls(fetch)).toBe(0);
  });

  it("never prefetches account status without credentials", async () => {
    setupHome();
    writeCache(10 * 60 * 1000);
    const fetch = stubZroFetch();
    const ext = await loadExtension();
    ext.getApiKeyForProvider.mockResolvedValue(undefined);
    await ext.startSession(interactiveCtx());
    await settle();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fetches account status once and shares it with the next process via zro-account.json", async () => {
    setupHome();
    writeCache(10 * 60 * 1000);
    const fetch = stubZroFetch();
    let ext = await loadExtension();
    await ext.startSession(interactiveCtx());
    await vi.waitFor(() => expect(statusCalls(fetch)).toBe(1));
    const accountPath = path.join(home, "cache", `${PROVIDER_ID}-account.json`);
    await vi.waitFor(() => expect(fs.existsSync(syncMetaPath(accountPath))).toBe(true));
    expect(JSON.parse(fs.readFileSync(accountPath, "utf8"))).toMatchObject({ availableUsd: 12.34, planName: "Pro" });
    expect(fs.readFileSync(syncMetaPath(accountPath), "utf8")).not.toContain(KEY);
    expect(fs.existsSync(syncLockPath(accountPath))).toBe(false);

    ext = await loadExtension(); // /new, /reload or another pi process within the window
    await ext.startSession(interactiveCtx());
    await settle();
    expect(statusCalls(fetch)).toBe(1);
    expect(modelCalls(fetch)).toBe(0); // model cache was fresh throughout
  });

  it("refetches account status once the shared snapshot is older than its TTL", async () => {
    setupHome();
    writeCache(10 * 60 * 1000);
    const accountPath = path.join(home, "cache", `${PROVIDER_ID}-account.json`);
    fs.writeFileSync(accountPath, JSON.stringify({ availableUsd: 1 }));
    fs.writeFileSync(syncMetaPath(accountPath), JSON.stringify({ version: 1, keyFingerprint: keyFingerprint(KEY) }));
    const old = new Date(Date.now() - 5 * 60 * 1000);
    fs.utimesSync(accountPath, old, old);
    const fetch = stubZroFetch();
    const ext = await loadExtension();
    await ext.startSession(interactiveCtx());
    await vi.waitFor(() => expect(statusCalls(fetch)).toBe(1));
  });
});
