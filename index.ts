/**
 * Zro Provider Extension
 *
 * Registers Zro (zro.moonmath.ai) as a custom provider using the
 * openai-completions API. Base URL: https://zro.moonmath.ai/v1
 *
 * Model metadata comes from Zro's CLI model catalog, GET /api/cli/models —
 * the same endpoint `zro models` uses. It provides canonical ids, display
 * names, context/output limits, and per-model reasoning effort levels (each
 * level pairs an id with a piLevel). patch.json remains available for
 * verified endpoint regressions, but currently contains no overrides.
 *
 * Model resolution strategy: Stale-While-Revalidate
 *   1. Serve stale immediately: disk cache → embedded models.json (zero-latency)
 *   2. Revalidate in background: live API /api/cli/models → merge with embedded → cache → hot-swap
 *   3. patch.json + custom-models.json applied on top of whichever source won
 *
 * Merge order: [live|cache|embedded] → apply patch.json → merge custom-models.json
 *
 * Footer Status Widget:
 *   A below-editor line shows Zro session + account state:
 *
 *     ⚡ $0.42 · 7 req           Pro ◆ $12.34 avail · $2.50 pack · 1.2k req/30d
 *     └─ session activity ──┘  └──────────────── account / quota ─────────────┘
 *
 *   The left side reports what this session has spent/sent: request count
 *   always, plus token totals and, when the response exposes one, a cost
 *   extension on each chat completion — pi requests
 *   stream_options.include_usage, so the final SSE chunk carries usage and we
 *   read it off a teed response stream, no polling). The right side reports
 *   the plan name, total available spend, usage-pack balance, and 30-day
 *   request/token activity from Zro's /api/cli/status endpoint (the same
 *   view `zro status` prints), plus a request-rate atom captured from
 *   response headers when present. The right side compresses across
 *   progressive tiers as the terminal narrows. The balance flips to a ⚠
 *   warning at/below lowBalanceUsd.
 *
 *   Lifecycle (mirrors pi-neuralwatt-provider): nothing renders before this
 *   session's first Zro turn completes, so fresh sessions and other
 *   providers' sessions see no half-empty line. Account status is prefetched
 *   on session start or model select when a Zro model is active, so the
 *   first turn ends with data already cached. It is polled again on pi's
 *   agent_settled event (fires only once no automatic retry, compaction, or
 *   queued continuation can follow) — and nowhere else, so sessions without
 *   Zro turns make zero status-related API calls. Between polls the balance
 *   moves optimistically: each turn's captured spend is deducted from the
 *   last available-spend value at turn_end so the account line tracks spend
 *   live; the agent_settled poll reconciles any drift.
 *
 * Display Configuration:
 *   Create ~/.pi/agent/extensions/zro.json:
 *   {
 *     "session": "widget",            // "widget" | "statusbar" | "off"
 *     "account": "widget",            // "widget" | "statusbar" | "off"
 *     "hideOnOtherProvider": true,    // hide when a non-Zro model is active
 *     "lowBalanceUsd": 10             // warn threshold, null/false disables
 *   }
 *
 *   - "widget" (default): rendered in the below-editor status line
 *   - "statusbar": rendered in the built-in pi status bar
 *   - "off": hidden entirely (account=off also skips status fetches)
 *
 *   Manage interactively with /zro-status, or non-interactively:
 *     /zro-status session widget|statusbar|off
 *     /zro-status account widget|statusbar|off
 *     /zro-status hide true|false
 *     /zro-status lowBalance <usd>|off
 *     /zro-status refresh          (re-fetch account status now)
 *     /zro-status reset
 *
 * Usage:
 *   # Option 1: Use your existing zro CLI login (no extra key needed)
 *   # Run `zro login` once; this extension reads ~/.config/zro/credentials.json
 *   # (XDG_CONFIG_HOME aware) as a fallback.
 *
 *   # Option 2: Store in auth.json (recommended)
 *   # Add to ~/.pi/agent/auth.json:
 *   #   "zro": { "type": "api_key", "key": "your-api-key" }
 *
 *   # Option 3: Set as environment variable
 *   export ZRO_API_KEY=your-api-key
 *
 *   # Run pi with the extension
 *   pi -e /path/to/pi-zro-provider
 *
 * Then use /model to select from available models.
 *
 * @see https://zro.moonmath.ai
 */

import { clampThinkingLevel, streamOpenAICompletions } from "@earendil-works/pi-ai/compat";
import type { AssistantMessageEventStream, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import modelsData from "./models.json" with { type: "json" };
import customModelsData from "./custom-models.json" with { type: "json" };
import patchData from "./patch.json" with { type: "json" };
import deprecatedData from "./deprecated-models.json" with { type: "json" };
import {
	applyOptimisticSpend,
	buildAccountTiers,
	buildSessionLine,
	coerceStatusConfig,
	DEFAULT_STATUS_CONFIG,
	EMPTY_ACCOUNT,
	EMPTY_SESSION_STATS,
	StatusLineWidget,
	accountHasData,
	type AccountState,
	type SessionStats,
	type StatusConfig,
} from "./status";
import fs from "fs";
import { homedir } from "os";
import path from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

interface JsonModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: Record<string, string | null>;
	compat?: {
		supportsDeveloperRole?: boolean;
		supportsStore?: boolean;
		maxTokensField?: "max_completion_tokens" | "max_tokens";
		thinkingFormat?: "openai" | "zai" | "qwen" | "qwen-chat-template" | "deepseek" | "openrouter" | "baseten" | "string-thinking" | "together" | "ant-ling" | "chat-template";
		supportsReasoningEffort?: boolean;
		requiresReasoningContentOnAssistantMessages?: boolean;
	};
}

interface PatchEntry {
	name?: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
	contextWindow?: number;
	maxTokens?: number;
	thinkingLevelMap?: Record<string, string | null>;
	compat?: Record<string, unknown>;
}

type PatchData = Record<string, PatchEntry>;

// ─── Patch Application ────────────────────────────────────────────────────────

function applyPatch(model: JsonModel, patch: PatchEntry): JsonModel {
	const result = { ...model };

	if (patch.name !== undefined) result.name = patch.name;
	if (patch.reasoning !== undefined) result.reasoning = patch.reasoning;
	if (patch.input !== undefined) result.input = patch.input;
	if (patch.contextWindow !== undefined) result.contextWindow = patch.contextWindow;
	if (patch.maxTokens !== undefined) result.maxTokens = patch.maxTokens;
	if (patch.thinkingLevelMap !== undefined) result.thinkingLevelMap = { ...patch.thinkingLevelMap };

	if (patch.cost) {
		result.cost = {
			input: patch.cost.input ?? result.cost.input,
			output: patch.cost.output ?? result.cost.output,
			cacheRead: patch.cost.cacheRead ?? result.cost.cacheRead,
			cacheWrite: patch.cost.cacheWrite ?? result.cost.cacheWrite,
		};
	}
	if (patch.compat) {
		result.compat = { ...(result.compat || {}), ...patch.compat };
	}

	if (!result.reasoning && result.compat?.thinkingFormat) {
		delete result.compat.thinkingFormat;
	}
	if (!result.reasoning && result.thinkingLevelMap) {
		delete result.thinkingLevelMap;
	}
	if (result.compat && Object.keys(result.compat).length === 0) {
		delete result.compat;
	}

	return result;
}

/** Full pipeline: base models → patch → custom → result */
function buildModels(base: JsonModel[], custom: JsonModel[], patch: PatchData): JsonModel[] {
	const modelMap = new Map<string, JsonModel>();

	// Seed with the base list plus grace-period deprecated models so patch.json
	// entries apply to deprecated models exactly as while the model was live
	// (withDeprecated keeps live data on id conflicts).
	for (const model of withDeprecated(base)) {
		modelMap.set(model.id, model);
	}

	for (const [id, patchEntry] of Object.entries(patch)) {
		const existing = modelMap.get(id);
		if (existing) {
			modelMap.set(id, applyPatch(existing, patchEntry));
		}
	}

	for (const model of custom) {
		const existing = modelMap.get(model.id);
		const patchEntry = patch[model.id];
		if (existing && patchEntry) {
			modelMap.set(model.id, applyPatch(model, patchEntry));
		} else if (existing) {
			modelMap.set(model.id, model);
		} else if (patchEntry) {
			modelMap.set(model.id, applyPatch(model, patchEntry));
		} else {
			modelMap.set(model.id, model);
		}
	}

	return Array.from(modelMap.values());
}

// ─── Stale-While-Revalidate Model Sync ────────────────────────────────────────

const PROVIDER_ID = "zro";
// Endpoint root is overridable like zro's own CLI (ZRO_ENDPOINT_ROOT).
const ENDPOINT_ROOT = (process.env.ZRO_ENDPOINT_ROOT || "https://zro.moonmath.ai").replace(/\/+$/, "");
const BASE_URL = `${ENDPOINT_ROOT}/v1`;
const MODELS_URL = `${ENDPOINT_ROOT}/api/cli/models`;
const STATUS_URL = `${ENDPOINT_ROOT}/api/cli/status`;
const CACHE_DIR = path.join(getAgentDir(), "cache");
const CACHE_PATH = path.join(CACHE_DIR, `${PROVIDER_ID}-models.json`);
const LIVE_FETCH_TIMEOUT_MS = 8000;

// pi thinking levels → provider level ids. Matches the transform zro's own
// pi adapter applies: each catalog reasoning level publishes a piLevel
// (off|minimal|low|medium|high|xhigh) and the id the inference proxy
// expects, e.g. glm-5.2 → { off: "none", high: "high", xhigh: "max" }.
const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

function buildZroThinkingLevelMap(levels: any[]): Record<string, string | null> {
	const result: Record<string, string | null> = {
		off: null,
		minimal: null,
		low: null,
		medium: null,
		high: null,
		xhigh: null,
	};
	for (const level of levels) {
		if (
			level &&
			typeof level === "object" &&
			typeof level.id === "string" &&
			level.id.trim() &&
			typeof level.piLevel === "string" &&
			Object.prototype.hasOwnProperty.call(result, level.piLevel)
		) {
			result[level.piLevel] = level.id;
		}
	}
	return result;
}

/** Transform a model from Zro's CLI model catalog (/api/cli/models). */
function transformApiModel(apiModel: any): JsonModel | null {
	if (typeof apiModel.id !== "string" || apiModel.id.length === 0) return null;

	const levels = Array.isArray(apiModel?.reasoning?.levels) ? apiModel.reasoning.levels : [];

	return {
		id: apiModel.id,
		name: apiModel.displayName || apiModel.id,
		reasoning: true,
		thinkingLevelMap: buildZroThinkingLevelMap(levels),
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: apiModel.contextWindow || 0,
		maxTokens: apiModel.maxOutputTokens || apiModel.contextWindow || 0,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			maxTokensField: "max_tokens",
		},
	};
}

async function fetchLiveModels(apiKey: string, signal?: AbortSignal): Promise<JsonModel[] | null> {
	try {
		const response = await fetch(MODELS_URL, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: signal ? AbortSignal.any([AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS), signal]) : AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS),
		});
		if (!response.ok) return null;
		const data = await response.json();
		const apiModels = Array.isArray(data) ? data : (data.models || data.data || []);
		if (!Array.isArray(apiModels) || apiModels.length === 0) return null;
		return apiModels.map(transformApiModel).filter((m): m is JsonModel => m !== null);
	} catch {
		return null;
	}
}

function loadCachedModels(): JsonModel[] | null {
	try {
		const data = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
		return Array.isArray(data) ? data : null;
	} catch {
		return null;
	}
}

function cacheModels(models: JsonModel[]): void {
	try {
		fs.mkdirSync(CACHE_DIR, { recursive: true });
		fs.writeFileSync(CACHE_PATH, JSON.stringify(models, null, 2) + "\n");
	} catch {
		// Cache write failure is non-fatal
	}
}

function mergeWithEmbedded(liveModels: JsonModel[], embeddedModels: JsonModel[]): JsonModel[] {
	const embeddedMap = new Map(embeddedModels.map(m => [m.id, m]));
	const seen = new Set<string>();
	const result: JsonModel[] = [];
	for (const liveModel of liveModels) {
		const embedded = embeddedMap.get(liveModel.id);
		seen.add(liveModel.id);
		if (embedded) {
			// The live catalog is authoritative for context/output limits;
			// curation (name/thinkingLevelMap/compat) still wins via ...embedded.
			result.push({
				...liveModel,
				...embedded,
				cost: liveModel.cost,
				contextWindow: liveModel.contextWindow || embedded.contextWindow,
				maxTokens: liveModel.maxTokens || embedded.maxTokens,
			});
		} else {
			result.push(liveModel);
		}
	}
	// Append any embedded models that the live API didn't return
	for (const em of embeddedModels) {
		if (!seen.has(em.id)) {
			result.push(em);
		}
	}
	return result;
}

// Grace period for delisted models. When the provider API stops listing a
// model, update-models.js moves its last-known definition into
// deprecated-models.json (stamped with deprecatedAt) instead of dropping it.
// For 14 days the model keeps working here so in-flight sessions and saved
// model settings do not break; afterwards it is evicted permanently.
const DEPRECATED_MODEL_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// Grace-period deprecated models with deprecation metadata stripped.
function activeDeprecatedModels(): JsonModel[] {
	const now = Date.now();
	const result: JsonModel[] = [];
	for (const entry of Object.values(deprecatedData as Record<string, JsonModel & { deprecatedAt?: string }>)) {
		if (!entry?.id) continue;
		const removedAt = Date.parse(entry.deprecatedAt ?? "");
		if (Number.isNaN(removedAt) || now - removedAt > DEPRECATED_MODEL_TTL_MS) continue;
		const model = { ...entry } as JsonModel & { deprecatedAt?: string };
		delete model.deprecatedAt;
		result.push(model);
	}
	return result;
}

// Append grace-period deprecated models the list does not already have (live data wins).
function withDeprecated(models: JsonModel[]): JsonModel[] {
	const seen = new Set(models.map((m) => m.id));
	const extras = activeDeprecatedModels().filter((m) => !seen.has(m.id));
	return extras.length > 0 ? [...models, ...extras] : models;
}

function loadStaleModels(embeddedModels: JsonModel[]): JsonModel[] {
	const cached = loadCachedModels();
	if (!cached || cached.length === 0) return embeddedModels;

	// Merge embedded models that are missing from cache (newly added models)
	const cachedMap = new Map(cached.map(m => [m.id, m]));
	for (const em of embeddedModels) {
		if (!cachedMap.has(em.id)) {
			cached.push(em);
		}
	}
	return cached;
}

async function revalidateModels(apiKey: string | undefined, embeddedModels: JsonModel[], signal?: AbortSignal): Promise<JsonModel[] | null> {
	if (!apiKey) return null;
	const liveModels = await fetchLiveModels(apiKey, signal);
	if (!liveModels || liveModels.length === 0) return null;
	const merged = mergeWithEmbedded(liveModels, embeddedModels);
	cacheModels(merged);
	return merged;
}

// ─── API Key Resolution (via ModelRegistry) ────────────────────────────────────

let cachedApiKey: string | undefined;
let revalidateAbort: AbortController | null = null;

/** The zro CLI stores its login at ~/.config/zro/credentials.json (XDG aware). */
function storedZroCliKey(): string | undefined {
	try {
		const configRoot = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
		const parsed = JSON.parse(fs.readFileSync(path.join(configRoot, "zro", "credentials.json"), "utf8"));
		return typeof parsed?.apiKey === "string" && parsed.apiKey.trim() ? parsed.apiKey : undefined;
	} catch {
		return undefined;
	}
}

async function resolveApiKey(modelRegistry: ModelRegistry): Promise<void> {
	cachedApiKey =
		(await modelRegistry.getApiKeyForProvider(PROVIDER_ID) ?? undefined) ||
		(process.env.ZRO_API_KEY ?? undefined) ||
		storedZroCliKey();
}

// ─── Status Display Configuration ──────────────────────────────────────────────

const CONFIG_PATH = path.join(getAgentDir(), "extensions", "zro.json");

let statusConfig: StatusConfig = { ...DEFAULT_STATUS_CONFIG };

function loadStatusConfig(): StatusConfig {
	try {
		const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
		statusConfig = coerceStatusConfig(raw);
	} catch {
		// Missing or unreadable file → defaults
	}
	return statusConfig;
}

function writeStatusConfig(): void {
	try {
		let raw: Record<string, unknown> = {};
		try {
			const existing = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
			if (existing && typeof existing === "object" && !Array.isArray(existing)) raw = existing;
		} catch {
			// No existing file — start fresh
		}
		raw.session = statusConfig.session;
		raw.account = statusConfig.account;
		raw.hideOnOtherProvider = statusConfig.hideOnOtherProvider;
		raw.lowBalanceUsd = statusConfig.lowBalanceUsd;
		fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
		fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2) + "\n");
	} catch {
		// Config write failure is non-fatal — the in-memory config still applies
	}
}

loadStatusConfig();

// ─── Response Metadata Capture ────────────────────────────────────────────────
// The custom streamSimple below wraps fetch per request (never globalThis —
// concurrent main/helper requests would clobber a global patch). For every
// /chat/completions response we capture x-ratelimit-* headers and tee the
// body: one copy goes to pi's OpenAI streaming layer, the other is scanned
// for the final usage chunk (tokens, spend extension) that closes the stream.

const sessionStats: SessionStats = { ...EMPTY_SESSION_STATS };
const account: AccountState = { ...EMPTY_ACCOUNT };

// Per-turn pending state — teed streams settle asynchronously, so capture
// lands in pending* and is committed at turn_end.
let pendingRequests = 0;
let pendingTokens = 0;
let pendingSpend = 0;
let pendingSawUsage = false;
let pendingSawOutOfCredits = false;
let outOfCreditsNotified = false;

const teeReaders = new Set<Promise<void>>();

function trackTeeReader(promise: Promise<void>): void {
	teeReaders.add(promise);
	const release = () => { teeReaders.delete(promise); };
	promise.then(release, release);
}

function settleTeeReaders(): Promise<void> {
	if (teeReaders.size === 0) return Promise.resolve();
	const pending = Array.from(teeReaders);
	return Promise.allSettled(pending).then(() => undefined);
}

function captureRateLimitHeaders(headers: Headers): void {
	const limit = Number(headers.get("x-ratelimit-limit"));
	const remaining = Number(headers.get("x-ratelimit-remaining"));
	if (Number.isFinite(limit) && Number.isFinite(remaining)) {
		account.rate = { limit, remaining, capturedAt: Date.now() };
		return;
	}
	// Fallback: hourly budget headers some proxies forward
	const limitHour = Number(headers.get("x-ratelimit-limit-hour"));
	const remainingHour = Number(headers.get("x-ratelimit-remaining-hour"));
	if (Number.isFinite(limitHour) && Number.isFinite(remainingHour)) {
		account.rate = { limit: limitHour, remaining: remainingHour, capturedAt: Date.now() };
	}
}

/** Extract spend/token data from a parsed completion chunk/body's usage object. */
function captureUsage(obj: any): void {
	const usage = obj?.usage;
	if (typeof usage !== "object" || usage === null) return;
	const input = usage.prompt_tokens;
	const output = usage.completion_tokens;
	if (typeof input === "number" && Number.isFinite(input)) pendingTokens += input;
	if (typeof output === "number" && Number.isFinite(output)) pendingTokens += output;
	// Metered proxies expose a cost extension (usage.total_cost / usage.cost.usd);
	// Zro may or may not — token totals are the always-available fallback.
	const total = usage.total_cost ?? usage.cost?.usd ?? usage.cost?.total;
	if (typeof total === "number" && Number.isFinite(total)) {
		pendingSpend += Math.max(0, total);
	}
	pendingSawUsage = true;
}

/** Scan a teed response for the final usage chunk (SSE) or JSON body usage. */
async function readUsageFromTee(body: ReadableStream<Uint8Array>): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	const processLine = (line: string): void => {
		const trimmed = line.trim();
		if (!trimmed.startsWith("data: ")) return;
		const payload = trimmed.slice(6);
		if (payload === "[DONE]") return;
		try {
			captureUsage(JSON.parse(payload));
		} catch {
			// Not JSON or no usage — benign
		}
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		}
	} catch {
		// Tee stream may error if the main stream is aborted — that's fine
	}

	const trailing = (buffer + decoder.decode(new Uint8Array(0), { stream: false })).trim();
	if (trailing) {
		if (trailing.startsWith("data: ")) {
			processLine(trailing);
		} else if (trailing.startsWith("{")) {
			try {
				captureUsage(JSON.parse(trailing));
			} catch {
				// Partial non-SSE body — ignore
			}
		}
	}

	try {
		reader.releaseLock();
	} catch {
		// Ignore
	}
}

// ─── Custom Streaming Provider ────────────────────────────────────────────────

function streamZro(
	model: any,
	context: any,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const apiKey = (options as any)?.apiKey || cachedApiKey || storedZroCliKey() || "";
	if (!apiKey) {
		throw new Error(
			`No API key for Zro. Run \`zro login\`, add it to ~/.pi/agent/auth.json, ` +
			`set ZRO_API_KEY env var, or use --api-key.`,
		);
	}

	const zroModel = { ...model, api: "openai-completions", baseUrl: model.baseUrl || BASE_URL };

	// pi hands the user's thinking selection as options.reasoning (a raw
	// ThinkingLevel); streamOpenAICompletions only reads reasoningEffort.
	// Replicate pi-ai's clamp+convert so levels reach the request body.
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(zroModel, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
	const { reasoning: _reasoning, ...streamOptions } = (options ?? {}) as any;

	// Per-request fetch wrapper: owns its interceptor, safe under concurrency.
	const upstreamFetch = (streamOptions as any).fetch ?? globalThis.fetch;
	const metaFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const response = await upstreamFetch(input as any, init);
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (!url.includes("/chat/completions")) return response;

		pendingRequests += 1;
		captureRateLimitHeaders(response.headers);
		if (response.status === 402) pendingSawOutOfCredits = true;
		if (!response.ok || !response.body) return response;

		const [bodyForSdk, bodyForMeta] = response.body.tee();
		trackTeeReader(readUsageFromTee(bodyForMeta));
		return new Response(bodyForSdk, {
			headers: response.headers,
			status: response.status,
			statusText: response.statusText,
		});
	};

	return streamOpenAICompletions(zroModel, context, {
		...streamOptions,
		fetch: metaFetch,
		reasoningEffort,
		apiKey,
	} as any);
}

// ─── Account Metadata Fetching ────────────────────────────────────────────────

const STATUS_MIN_INTERVAL_MS = 15_000;
const ACCOUNT_FETCH_TIMEOUT_MS = 8_000;

let statusAbort: AbortController | null = null;
// Bumped on every session_start; async continuations compare against this to
// drop work belonging to a replaced session (its ctx is stale and throws).
let statusEpoch = 0;
let lastStatusFetchAt = 0;
let statusInFlight: Promise<void> | null = null;
let metaFetched = false;

async function fetchJsonGet(url: string, apiKey: string, signal?: AbortSignal): Promise<any | null> {
	try {
		const response = await fetch(url, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: signal
				? AbortSignal.any([AbortSignal.timeout(ACCOUNT_FETCH_TIMEOUT_MS), signal])
				: AbortSignal.timeout(ACCOUNT_FETCH_TIMEOUT_MS),
		});
		if (!response.ok) return null;
		return await response.json();
	} catch {
		return null;
	}
}

/** Plan/spend/pack/activity from /api/cli/status — the `zro status` view. Throttled unless forced. */
function refreshAccountStatus(apiKey: string | undefined, signal: AbortSignal | undefined, force: boolean): Promise<void> {
	if (!apiKey) return Promise.resolve();
	if (!force && Date.now() - lastStatusFetchAt < STATUS_MIN_INTERVAL_MS) return Promise.resolve();
	lastStatusFetchAt = Date.now();
	if (statusInFlight) return statusInFlight;
	statusInFlight = (async () => {
		try {
			const data = await fetchJsonGet(STATUS_URL, apiKey, signal);
			if (data === null) return;
			const billing = data?.billing;
			if (billing && typeof billing === "object") {
				if (typeof billing.totalRemaining === "number") account.availableUsd = billing.totalRemaining;
				if (typeof billing.usagePacks?.remaining === "number") account.usagePackUsd = billing.usagePacks.remaining;
				const planName = billing.plan?.name;
				if (typeof planName === "string" && planName.trim()) account.planName = planName.trim();
			}
			const activity = data?.activity30d;
			if (activity && typeof activity === "object") {
				if (typeof activity.requests === "number") account.activity30dRequests = activity.requests;
				if (typeof activity.totalTokens === "number") account.activity30dTokens = activity.totalTokens;
			}
			if (typeof data?.key?.alias === "string" && data.key.alias.trim()) account.keyAlias = data.key.alias.trim();
			metaFetched = true;
		} finally {
			statusInFlight = null;
		}
	})();
	return statusInFlight;
}

// ─── Status Rendering ─────────────────────────────────────────────────────────

const WIDGET_KEY = "zro";
const STATUS_KEY_SESSION = "zro-session";
const STATUS_KEY_ACCOUNT = "zro-account";

function currentProviderId(ctx: ExtensionContext): string | undefined {
	// ctx.model is a getter that can throw on stale contexts
	try {
		return (ctx.model as any)?.provider as string | undefined;
	} catch {
		return undefined;
	}
}

function isStaleCtxError(err: unknown): boolean {
	return err instanceof Error && err.message.includes("This extension ctx is stale");
}

// Render entry point: swallows the stale-ctx throw so a refresh racing a
// session replacement (newSession/fork/switchSession/reload) can't crash pi.
function updateStatus(ctx: ExtensionContext): void {
	try {
		renderStatus(ctx);
	} catch (err) {
		if (!isStaleCtxError(err)) throw err;
	}
}

// Re-render once an async refresh lands, unless the session was replaced
// meanwhile (epoch bump) — its ctx is stale and the render is obsolete anyway.
function updateStatusAfter(promise: Promise<void>, ctx: ExtensionContext): void {
	const epoch = statusEpoch;
	void promise.then(() => {
		if (epoch === statusEpoch) updateStatus(ctx);
	});
}

function renderStatus(ctx: ExtensionContext): void {
	const provider = currentProviderId(ctx);
	const hiddenByOtherProvider =
		statusConfig.hideOnOtherProvider && provider !== undefined && provider !== PROVIDER_ID;

	const clearAll = () => {
		ctx.ui.setStatus(STATUS_KEY_SESSION, undefined);
		ctx.ui.setStatus(STATUS_KEY_ACCOUNT, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	};

	if (hiddenByOtherProvider) {
		clearAll();
		return;
	}

	const hasActivity = sessionStats.requests > 0 || sessionStats.tokens > 0 || sessionStats.spend > 0;
	const sessionLine = statusConfig.session !== "off" ? buildSessionLine(sessionStats) : undefined;
	// Show only after Zro activity this session (like pi-neuralwatt):
	// no empty-gap line on fresh sessions, no stale account glare on other
	// providers' sessions.
	const accountVisible = statusConfig.account !== "off" && accountHasData(account) && hasActivity;
	const lowBalance =
		statusConfig.lowBalanceUsd !== null && account.availableUsd !== null && account.availableUsd <= statusConfig.lowBalanceUsd;
	const accTiers = accountVisible ? buildAccountTiers(account, lowBalance) : [];

	// Status bar (built-in footer slots)
	const sBar = statusConfig.session === "statusbar" ? sessionLine : undefined;
	const aBar = statusConfig.account === "statusbar" && accountVisible ? accTiers[0] : undefined;
	if (sBar && aBar) {
		// Combined to avoid eating two footer slots
		ctx.ui.setStatus(STATUS_KEY_SESSION, ctx.ui.theme.fg(lowBalance ? "warning" : "dim", `${sBar} · ${aBar}`));
		ctx.ui.setStatus(STATUS_KEY_ACCOUNT, undefined);
	} else {
		ctx.ui.setStatus(STATUS_KEY_SESSION, sBar ? ctx.ui.theme.fg("dim", sBar) : undefined);
		ctx.ui.setStatus(STATUS_KEY_ACCOUNT, aBar ? ctx.ui.theme.fg(lowBalance ? "warning" : "dim", aBar) : undefined);
	}

	// Below-editor widget (two-zone, width-aware)
	const leftW = statusConfig.session === "widget" ? sessionLine : undefined;
	const rightW = statusConfig.account === "widget" && accountVisible ? accTiers : undefined;
	if (leftW !== undefined || (rightW !== undefined && rightW.length > 0)) {
		ctx.ui.setWidget(
			WIDGET_KEY,
			(_tui: any, theme: any) => new StatusLineWidget(theme, leftW ?? "", rightW ?? [], lowBalance),
			{ placement: "belowEditor" },
		);
	} else {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	}
}

function resetStatusState(): void {
	sessionStats.requests = 0;
	sessionStats.tokens = 0;
	sessionStats.spend = 0;
	Object.assign(account, EMPTY_ACCOUNT);
	pendingRequests = 0;
	pendingTokens = 0;
	pendingSpend = 0;
	pendingSawUsage = false;
	pendingSawOutOfCredits = false;
	outOfCreditsNotified = false;
	lastStatusFetchAt = 0;
	metaFetched = false;
}

/** Commit per-turn pending capture into session state (after tees settle). */
function commitPending(ctx: ExtensionContext): void {
	if (!pendingSawUsage && pendingRequests === 0) return;
	sessionStats.requests += pendingRequests;
	sessionStats.tokens += pendingTokens;
	sessionStats.spend += pendingSpend;

	// Optimistic balance: deduct this turn's observed spend so the account
	// line ticks down per turn with zero extra API calls. Every status poll
	// overwrites account.availableUsd (never adjusts), so this cannot
	// double-count; the agent_settled poll reconciles any drift.
	applyOptimisticSpend(account, pendingSpend);

	pendingRequests = 0;
	pendingTokens = 0;
	pendingSpend = 0;
	pendingSawUsage = false;

	if (pendingSawOutOfCredits) {
		pendingSawOutOfCredits = false;
		// Re-fetch now so the balance reflects exhaustion immediately
		updateStatusAfter(refreshAccountStatus(cachedApiKey, statusAbort?.signal ?? undefined, true), ctx);
		if (!outOfCreditsNotified && ctx.hasUI) {
			outOfCreditsNotified = true;
			ctx.ui.notify("Zro has run out of available spend — top up at zro.moonmath.ai", "error");
		}
	}
}

// ─── Status Command ────────────────────────────────────────────────────────────

function statusSummary(): string {
	const lb = statusConfig.lowBalanceUsd === null ? "off" : `${statusConfig.lowBalanceUsd}`;
	return `session=${statusConfig.session}, account=${statusConfig.account}, hideOnOtherProvider=${statusConfig.hideOnOtherProvider}, lowBalanceUsd=${lb}`;
}

const STATUS_USAGE =
	"Usage: /zro-status [session|account widget|statusbar|off · hide true|false · lowBalance <usd>|off · refresh · reset]";

async function handleStatusCommand(args: string, ctx: ExtensionContext): Promise<void> {
	const tokens = args.trim().split(/\s+/).filter(Boolean);

	if (tokens.length === 0) {
		if (!ctx.hasUI) {
			ctx.ui.notify(statusSummary(), "info");
			return;
		}
		await configureStatusInteractive(ctx);
		return;
	}

	const [rawKey, rawValue] = tokens;
	const key = rawKey.toLowerCase();
	const value = rawValue?.toLowerCase();

	if (key === "refresh") {
		metaFetched = false;
		await refreshAccountStatus(cachedApiKey, statusAbort?.signal ?? undefined, true);
		updateStatus(ctx);
		const bal = account.availableUsd !== null ? `$${account.availableUsd} avail` : "unknown";
		ctx.ui.notify(`Zro account: ${bal}. ${statusSummary()}`, "info");
		return;
	}

	if (key === "reset" && tokens.length === 1) {
		statusConfig = { ...DEFAULT_STATUS_CONFIG };
		writeStatusConfig();
		updateStatus(ctx);
		ctx.ui.notify(`Zro status reset. ${statusSummary()}`, "info");
		return;
	}

	if ((key === "session" || key === "account") && tokens.length === 2) {
		if (value !== "widget" && value !== "statusbar" && value !== "off") {
			ctx.ui.notify(STATUS_USAGE, "error");
			return;
		}
		statusConfig[key] = value;
		writeStatusConfig();
		if (value !== "off" && key === "account") {
			// Turning account on: make sure we have data to show
			updateStatusAfter(refreshAccountStatus(cachedApiKey, statusAbort?.signal ?? undefined, true), ctx);
		}
		updateStatus(ctx);
		ctx.ui.notify(`Zro ${key} line: ${value}. ${statusSummary()}`, "info");
		return;
	}

	if ((key === "hide" || key === "hideonotherprovider") && tokens.length === 2) {
		if (value !== "true" && value !== "false") {
			ctx.ui.notify(STATUS_USAGE, "error");
			return;
		}
		statusConfig.hideOnOtherProvider = value === "true";
		writeStatusConfig();
		updateStatus(ctx);
		ctx.ui.notify(`Zro status. ${statusSummary()}`, "info");
		return;
	}

	if (key === "lowbalance" && tokens.length === 2) {
		if (value === "off") {
			statusConfig.lowBalanceUsd = null;
		} else {
			const n = Number(value);
			if (!Number.isFinite(n) || n <= 0) {
				ctx.ui.notify(STATUS_USAGE, "error");
				return;
			}
			statusConfig.lowBalanceUsd = n;
		}
		writeStatusConfig();
		updateStatus(ctx);
		ctx.ui.notify(`Zro status. ${statusSummary()}`, "info");
		return;
	}

	ctx.ui.notify(STATUS_USAGE, "error");
}

async function configureStatusInteractive(ctx: ExtensionContext): Promise<void> {
	const modes = ["widget", "statusbar", "off"] as const;
	const nextMode = (m: string) => modes[(modes.indexOf(m as any) + 1) % modes.length];

	for (;;) {
		const lb = statusConfig.lowBalanceUsd === null ? "off" : `$${statusConfig.lowBalanceUsd}`;
		const sessionOpt = `Session line (spend/tokens/requests): ${statusConfig.session}`;
		const accountOpt = `Account line (plan/balance/packs/activity): ${statusConfig.account}`;
		const hideOpt = `Hide on other providers: ${statusConfig.hideOnOtherProvider ? "on" : "off"}`;
		const lbOpt = `Low-balance warning: ${lb}`;
		const refreshOpt = "Refresh account status now";
		const doneOpt = "Done";

		const choice = await ctx.ui.select("Zro footer status", [
			sessionOpt,
			accountOpt,
			hideOpt,
			lbOpt,
			refreshOpt,
			doneOpt,
		]);

		if (choice === undefined || choice === doneOpt) {
			updateStatus(ctx);
			return;
		}
		if (choice === sessionOpt) {
			statusConfig.session = nextMode(statusConfig.session);
			writeStatusConfig();
			continue;
		}
		if (choice === accountOpt) {
			statusConfig.account = nextMode(statusConfig.account);
			writeStatusConfig();
			if (statusConfig.account !== "off") {
				updateStatusAfter(refreshAccountStatus(cachedApiKey, statusAbort?.signal ?? undefined, true), ctx);
			}
			continue;
		}
		if (choice === hideOpt) {
			statusConfig.hideOnOtherProvider = !statusConfig.hideOnOtherProvider;
			writeStatusConfig();
			updateStatus(ctx);
			continue;
		}
		if (choice === lbOpt) {
			const presets = ["off", "1", "5", "10", "25", "50", "100"];
			const current = statusConfig.lowBalanceUsd === null ? "off" : String(statusConfig.lowBalanceUsd);
			const ordered = presets.includes(current) ? presets : [current, ...presets];
			const pick = await ctx.ui.select("Warn at/below balance (USD)", ordered);
			if (pick !== undefined) {
				statusConfig.lowBalanceUsd = pick === "off" ? null : Number(pick);
				writeStatusConfig();
				updateStatus(ctx);
			}
			continue;
		}
		if (choice === refreshOpt) {
			metaFetched = false;
			await refreshAccountStatus(cachedApiKey, statusAbort?.signal ?? undefined, true);
			updateStatus(ctx);
			continue;
		}
	}
}

// ─── Extension Entry Point ────────────────────────────────────────────────────

// The currently-registered model list — starts stale, hot-swapped when the
// live catalog lands. Provider identity funnels through makeProviderConfig so
// the stream handler and models never desync.
let currentModels: JsonModel[] = [];

function makeProviderConfig(models: JsonModel[] = currentModels) {
	return {
		baseUrl: BASE_URL,
		apiKey: "$ZRO_API_KEY",
		// Custom API name so our streamSimple registers as its own handler and
		// never shadows pi's built-in openai-completions pipeline for other
		// providers. streamZro delegates to pi-ai's OpenAI-compat streamer.
		api: "zro",
		headers: { "User-Agent": "pi-coding-agent" },
		models,
		streamSimple: streamZro,
	};
}

export default function (pi: ExtensionAPI) {
	const embeddedModels = modelsData as JsonModel[];
	const customModels = customModelsData as JsonModel[];
	const patches = patchData as PatchData;

	const staleBase = loadStaleModels(embeddedModels);
	const staleModels = buildModels(staleBase, customModels, patches);
	currentModels = staleModels;

	pi.registerProvider(PROVIDER_ID, makeProviderConfig(staleModels));

	pi.registerCommand("zro-status", {
		description: "Configure the Zro footer status (session spend, account balance, packs, activity)",
		handler: async (args, ctx) => {
			await handleStatusCommand(args, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const epoch = ++statusEpoch;
		revalidateAbort?.abort();
		revalidateAbort = new AbortController();
		const signal = revalidateAbort.signal;
		statusAbort?.abort();
		statusAbort = new AbortController();
		const statusSignal = statusAbort.signal;

		loadStatusConfig();
		resetStatusState();
		updateStatus(ctx); // clears any carryover; activity-gated, renders nothing yet
		// Re-register so our identity (custom api + streamSimple) always wins
		// over anything that touched provider registration during load.
		pi.registerProvider(PROVIDER_ID, makeProviderConfig());

		resolveApiKey(ctx.modelRegistry).then(() => {
			// A session replacement while the key resolved invalidated the
			// captured ctx (fast-resume, /new, /fork); nothing below may touch it.
			if (epoch !== statusEpoch) return;
			// Prefetch account status only when a Zro model is active
			// (pi-neuralwatt also prefetches so the first turn ends with data, but
			// gating here avoids API calls in sessions that never use the provider).
			if (currentProviderId(ctx) === PROVIDER_ID) {
				updateStatusAfter(refreshAccountStatus(cachedApiKey, statusSignal, true), ctx);
			}
			revalidateModels(cachedApiKey, embeddedModels, signal).then((freshBase) => {
				if (freshBase && epoch === statusEpoch && !signal.aborted) {
					currentModels = buildModels(freshBase, customModels, patches);
					pi.registerProvider(PROVIDER_ID, makeProviderConfig());
				}
			});
		});
	});

	pi.on("model_select", (event, ctx) => {
		updateStatus(ctx);
		const model: any = (event as any).model;
		if (model?.provider === PROVIDER_ID && cachedApiKey) {
			updateStatusAfter(refreshAccountStatus(cachedApiKey, statusAbort?.signal ?? undefined, false), ctx);
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		// Ensure every concurrent response tee has landed before committing.
		await settleTeeReaders();
		commitPending(ctx);
		// If the session_start/model_select status fetch raced or failed, retry
		// once we have real activity so the very first turn shows the balance.
		if (sessionStats.requests > 0 && account.availableUsd === null && !metaFetched) {
			await refreshAccountStatus(cachedApiKey, statusAbort?.signal ?? undefined, false);
		}
		updateStatus(ctx);
	});

	// agent_settled (not agent_end): fires only when no automatic retry,
	// compaction, or queued continuation can follow — the one moment polling
	// /api/cli/status is both fresh and not redundant. Gated on session activity
	// so sessions without Zro turns make zero API calls here.
	pi.on("agent_settled", async (_event, ctx) => {
		if (sessionStats.requests > 0 || sessionStats.tokens > 0 || sessionStats.spend > 0) {
			await refreshAccountStatus(cachedApiKey, statusAbort?.signal ?? undefined, false);
			updateStatus(ctx);
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		revalidateAbort?.abort();
		statusAbort?.abort();
		ctx.ui.setStatus(STATUS_KEY_SESSION, undefined);
		ctx.ui.setStatus(STATUS_KEY_ACCOUNT, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	});
}
