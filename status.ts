/**
 * Footer status presentation for the Zro extension.
 *
 * Pure functions + a width-aware widget component — no pi runtime imports.
 * index.ts owns fetching, events, and config persistence; this module turns
 * state snapshots into terminal strings.
 *
 * Layout (below-editor widget, neuralwatt style):
 *
 *   ⚡ $0.42 · 7 req              Pro ◆ $12.34 avail · $2.50 pack · 1.2k req/30d
 *   └ left: session activity ─┘  └───────────── right: account / quota ─────────┘
 *
 * The left side is preserved at full fidelity. The right side is rendered
 * from a tier list (most → least detailed); render() picks the first tier
 * that fits the remaining width, and as a last resort truncates the minimal
 * tier. Width math counts only terminal-visible columns (ANSI-aware, wide
 * glyphs like ⚡ ⚠ measure 2 columns).
 */

export type DisplayMode = "widget" | "statusbar" | "off";

export interface StatusConfig {
	session: DisplayMode;
	account: DisplayMode;
	hideOnOtherProvider: boolean;
	lowBalanceUsd: number | null;
}

export const DEFAULT_STATUS_CONFIG: StatusConfig = {
	session: "widget",
	account: "widget",
	hideOnOtherProvider: true,
	lowBalanceUsd: 10,
};

const VALID_MODES = new Set<string>(["widget", "statusbar", "off"]);

function coerceMode(value: unknown, fallback: DisplayMode): DisplayMode {
	return typeof value === "string" && VALID_MODES.has(value) ? (value as DisplayMode) : fallback;
}

export function coerceStatusConfig(raw: unknown): StatusConfig {
	const d = DEFAULT_STATUS_CONFIG;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ...d };
	const r = raw as Record<string, unknown>;
	return {
		session: coerceMode(r.session, d.session),
		account: coerceMode(r.account, d.account),
		hideOnOtherProvider: typeof r.hideOnOtherProvider === "boolean" ? r.hideOnOtherProvider : d.hideOnOtherProvider,
		lowBalanceUsd:
			typeof r.lowBalanceUsd === "number" && Number.isFinite(r.lowBalanceUsd) && r.lowBalanceUsd > 0
				? r.lowBalanceUsd
				: r.lowBalanceUsd === null || r.lowBalanceUsd === false
					? null
					: d.lowBalanceUsd,
	};
}

// State snapshots
export interface RateLimitState {
	limit: number;
	remaining: number;
	capturedAt: number;
}

export interface AccountState {
	availableUsd: number | null;
	planName: string | null;
	usagePackUsd: number | null;
	activity30dRequests: number | null;
	activity30dTokens: number | null;
	rate: RateLimitState | null;
	keyAlias: string | null;
}

export const EMPTY_ACCOUNT: AccountState = {
	availableUsd: null,
	planName: null,
	usagePackUsd: null,
	activity30dRequests: null,
	activity30dTokens: null,
	rate: null,
	keyAlias: null,
};

export interface SessionStats {
	requests: number;
	tokens: number;
	spend: number;
}

export const EMPTY_SESSION_STATS: SessionStats = { requests: 0, tokens: 0, spend: 0 };

export function applyOptimisticSpend(acc: AccountState, spendUsd: number): void {
	if (spendUsd > 0 && acc.availableUsd !== null) {
		acc.availableUsd = Math.max(0, acc.availableUsd - spendUsd);
	}
}

// Formatters
function trimZeros(text: string): string {
	return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

export function formatUsd(n: number): string {
	if (!Number.isFinite(n)) return "?";
	if (n <= 0) return "$0";
	if (n < 0.01) return "~$0.01";
	const abs = Math.abs(n);
	if (abs >= 1_000_000) return `$${trimZeros((n / 1_000_000).toFixed(2))}M`;
	if (abs >= 10_000) return `$${trimZeros((n / 1_000).toFixed(1))}k`;
	if (abs >= 100) return `$${Math.round(n)}`;
	return `$${trimZeros(n.toFixed(2))}`;
}

export function formatTokens(n: number): string {
	if (!Number.isFinite(n)) return "?";
	if (n <= 0) return "0";
	if (n < 1000) return String(Math.round(n));
	if (n < 1_000_000) return `${trimZeros((n / 1000).toFixed(1))}k`;
	return `${trimZeros((n / 1_000_000).toFixed(2))}M`;
}

export function formatCount(n: number): string {
	if (!Number.isFinite(n)) return "?";
	if (n >= 1_000_000) return `${trimZeros((n / 1_000_000).toFixed(2))}M`;
	if (n >= 1000) return `${trimZeros((n / 1000).toFixed(1))}k`;
	return String(Math.max(0, Math.round(n)));
}

// Line builders
export function buildSessionLine(stats: SessionStats): string | undefined {
	if (stats.requests <= 0 && stats.tokens <= 0 && stats.spend <= 0) return undefined;
	const req = `${stats.requests} req`;
	if (stats.spend > 0) return `⚡ ${formatUsd(stats.spend)} · ${req}`;
	if (stats.tokens > 0) return `⚡ ${formatTokens(stats.tokens)} tok · ${req}`;
	return `⚡ ${req}`;
}

export function accountHasData(acc: AccountState): boolean {
	return (
		acc.availableUsd !== null ||
		acc.planName !== null ||
		acc.usagePackUsd !== null ||
		acc.activity30dRequests !== null ||
		acc.activity30dTokens !== null ||
		acc.rate !== null ||
		acc.keyAlias !== null
	);
}

export function buildAccountTiers(acc: AccountState, lowBalance: boolean): string[] {
	const gem = lowBalance ? "⚠ ◆" : "◆";
	const bal = acc.availableUsd !== null ? `${gem} ${formatUsd(acc.availableUsd)} avail` : undefined;
	const plan = acc.planName?.trim() || undefined;
	const pack = acc.usagePackUsd !== null && acc.usagePackUsd > 0 ? `${formatUsd(acc.usagePackUsd)} pack` : undefined;
	const actTok = acc.activity30dTokens !== null && acc.activity30dTokens > 0 ? `${formatTokens(acc.activity30dTokens)} tok/30d` : undefined;
	const actReq = acc.activity30dRequests !== null ? `${formatCount(acc.activity30dRequests)} req/30d` : undefined;
	const rate = acc.rate !== null ? `${formatCount(acc.rate.remaining)}/${formatCount(acc.rate.limit)}` : undefined;
	const head = [plan, bal].filter((p): p is string => !!p).join(" ") || undefined;
	const numOnly = acc.availableUsd !== null ? formatUsd(acc.availableUsd) : undefined;

	const join = (parts: (string | undefined)[]) => parts.filter((p): p is string => !!p).join(" · ");

	const tiers: string[] = [
		join([head, pack, actTok, actReq, rate]),
		join([head, pack, actReq, rate]),
		join([head, pack, actReq]),
		join([head, actTok, actReq]),
		join([head, actReq]),
		join([head, rate]),
		join([head]),
		join([bal, actReq]),
		join([bal]),
		join([numOnly]),
	];

	// Dedupe adjacent identical tiers (happens when atoms are missing).
	// Enforce monotonic non-increasing width so render() can trust ordering
	// even on pathological data (a tier wider than its predecessor is dropped).
	const out: string[] = [];
	for (const t of tiers) {
		if (!t || t === out[out.length - 1]) continue;
		if (out.length > 0 && termVisWidth(t) > termVisWidth(out[out.length - 1])) continue;
		out.push(t);
	}
	return out;
}

// Terminal width math (adapted from pi-neuralwatt-provider)
const EMOJI_RE = /\p{Emoji_Presentation}/u;
const AMBIGUOUS_WIDE = new Set(["■", "▲", "◉"]);

export function termVisWidth(str: string): number {
	let width = 0;
	let i = 0;
	while (i < str.length) {
		const code = str.charCodeAt(i);
		if (code === 0x1b && i + 1 < str.length) {
			const next = str.charCodeAt(i + 1);
			if (next === 0x5b) {
				i += 2;
				while (i < str.length && str.charCodeAt(i) >= 0x20 && str.charCodeAt(i) <= 0x3f) i++;
				while (i < str.length && str.charCodeAt(i) >= 0x30 && str.charCodeAt(i) <= 0x3f) i++;
				if (i < str.length) i++;
				continue;
			}
		}
		const cp = str.codePointAt(i)!;
		const char = cp > 0xffff ? str.slice(i, i + 2) : str[i];
		if (cp >= 0x1f1e6 && cp <= 0x1f1ff) {
			width += 1;
		} else if (EMOJI_RE.test(char)) {
			width += 2;
		} else if (AMBIGUOUS_WIDE.has(char)) {
			width += 2;
		} else {
			width += 1;
		}
		i += cp > 0xffff ? 2 : 1;
	}
	return width;
}

export function truncateAnsi(str: string, maxCols: number): string {
	if (maxCols <= 0) return "";
	if (termVisWidth(str) <= maxCols) return str;
	let result = "";
	let visWidth = 0;
	let i = 0;
	const target = maxCols - 1;
	while (i < str.length) {
		const code = str.charCodeAt(i);
		if (code === 0x1b && i + 1 < str.length && str.charCodeAt(i + 1) === 0x5b) {
			const start = i;
			i += 2;
			while (i < str.length && str.charCodeAt(i) >= 0x20 && str.charCodeAt(i) <= 0x3f) i++;
			while (i < str.length && str.charCodeAt(i) >= 0x30 && str.charCodeAt(i) <= 0x3f) i++;
			if (i < str.length) i++;
			result += str.slice(start, i);
			continue;
		}
		const cp = str.codePointAt(i)!;
		const char = cp > 0xffff ? str.slice(i, i + 2) : str[i];
		let charWidth: number;
		if (cp >= 0x1f1e6 && cp <= 0x1f1ff) charWidth = 1;
		else if (EMOJI_RE.test(char)) charWidth = 2;
		else if (AMBIGUOUS_WIDE.has(char)) charWidth = 2;
		else charWidth = 1;
		if (visWidth + charWidth > target) break;
		result += char;
		visWidth += charWidth;
		i += cp > 0xffff ? 2 : 1;
	}
	return result + "…";
}

export interface LineTheme {
	fg(color: string, text: string): string;
}

export class StatusLineWidget {
	private theme: LineTheme;
	private leftRaw: string;
	private rightTiers: string[];
	private rightWarn: boolean;

	constructor(theme: LineTheme, leftRaw: string, rightTiers: string[] = [], rightWarn = false) {
		this.theme = theme;
		this.leftRaw = leftRaw;
		this.rightTiers = rightTiers;
		this.rightWarn = rightWarn;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const leftVis = termVisWidth(this.leftRaw);
		if (leftVis > width) {
			return [this.theme.fg("dim", truncateAnsi(this.leftRaw, width))];
		}

		const rightColor = this.rightWarn ? "warning" : "dim";
		const themedLeft = this.theme.fg("dim", this.leftRaw);
		const budget = width - leftVis - 1;

		for (const tier of this.rightTiers) {
			if (termVisWidth(tier) <= budget) {
				const themedRight = this.theme.fg(rightColor, tier);
				const pad = width - termVisWidth(themedLeft) - termVisWidth(themedRight);
				return [themedLeft + " ".repeat(Math.max(1, pad)) + themedRight];
			}
		}

		const pad = width - termVisWidth(themedLeft);
		return [themedLeft + " ".repeat(Math.max(0, pad))];
	}
}
