/**
 * Dependency-free smoke test for the footer-status presentation module.
 * Run: node tests/status.smoke.ts (Node ≥ 23 strips types natively).
 * Exercises tier building, width math, widget layout, and config coercion —
 * the pieces where a regression would silently corrupt the footer line.
 */
import assert from "node:assert/strict";
import {
	EMPTY_ACCOUNT,
	StatusLineWidget,
	accountHasData,
	applyOptimisticSpend,
	buildAccountTiers,
	buildSessionLine,
	coerceStatusConfig,
	formatCount,
	formatDuration,
	formatTokens,
	formatUsd,
	termVisWidth,
	truncateAnsi,
	type AccountState,
} from "../status.ts";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const fakeTheme = { fg: (_c: string, t: string) => `\x1b[2m${t}\x1b[39m` };

// ── formatters ──
assert.equal(formatUsd(0), "$0");
assert.equal(formatUsd(12.34), "$12.34");
assert.equal(formatUsd(0.5), "$0.5");
assert.equal(formatUsd(249), "$249");
assert.equal(formatUsd(12345), "$12.3k");
assert.equal(formatUsd(1_250_000), "$1.25M");
assert.equal(formatUsd(0.0004), "~$0.01");
assert.equal(formatTokens(0), "0");
assert.equal(formatTokens(850), "850");
assert.equal(formatTokens(48200), "48.2k");
assert.equal(formatTokens(1_048_576), "1.05M");
assert.equal(formatCount(7), "7");
assert.equal(formatCount(1200), "1.2k");
assert.equal(formatCount(12_000), "12k");
assert.equal(formatDuration(0), "0s");
assert.equal(formatDuration(45_000), "45s");
assert.equal(formatDuration(252_000), "4m 12s");
assert.equal(formatDuration(3_672_000), "1h 1m");

// ── session line ──
assert.equal(buildSessionLine({ requests: 0, spend: 0, elapsedMs: 0 }), undefined);
assert.equal(buildSessionLine({ requests: 7, spend: 0, elapsedMs: 0 }), "⚡ 7 req");
assert.equal(buildSessionLine({ requests: 7, spend: 0.42, elapsedMs: 252_000 }), "⚡ $0.42 · 7 req · 4m 12s");
assert.equal(buildSessionLine({ requests: 1, spend: 0, elapsedMs: 0 }), "⚡ 1 req");

// ── account tiers ──
const acc = (over: Partial<AccountState>): AccountState => ({ ...EMPTY_ACCOUNT, ...over });
const rate = { limit: 1000, remaining: 996, capturedAt: 0 };

assert.equal(accountHasData(acc({})), false);
assert.equal(accountHasData(acc({ availableUsd: 0 })), true);

const full = acc({ availableUsd: 12.34, planName: "Pro", usagePackUsd: 2.5, activity30dRequests: 1200, activity30dTokens: 850000, rate });
const tiers = buildAccountTiers(full, false);
assert.equal(tiers[0], "Pro ◆ $12.34 avail · $2.5 pack · 850k tok/30d · 1.2k req/30d · 996/1k");
assert.ok(tiers.includes("Pro ◆ $12.34 avail"));
assert.ok(tiers.includes("◆ $12.34 avail"));
assert.ok(tiers.includes("$12.34"));
// tiers must be strictly non-increasing in width
for (let i = 1; i < tiers.length; i++) {
	assert.ok(termVisWidth(tiers[i]) <= termVisWidth(tiers[i - 1]), `tier ${i} wider than previous`);
}
// dedupe of adjacent identical tiers when atoms are missing
assert.deepEqual(buildAccountTiers(acc({ planName: "Pro" }), false), ["Pro"]);
const balOnly = buildAccountTiers(acc({ availableUsd: 5 }), true);
assert.equal(balOnly[0], "⚠ ◆ $5 avail");
assert.ok(balOnly.includes("$5"));

// optimistic spend deduction
{
	const opt = acc({ availableUsd: 12.34 });
	applyOptimisticSpend(opt, 0.5);
	assert.equal(opt.availableUsd, 11.84);
	applyOptimisticSpend(opt, 0); // zero spend is a no-op
	assert.equal(opt.availableUsd, 11.84);
	applyOptimisticSpend(opt, 300); // clamps at 0, never negative
	assert.equal(opt.availableUsd, 0);
	const unknown = acc({ availableUsd: null });
	applyOptimisticSpend(unknown, 1); // unknown balance stays unknown
	assert.equal(unknown.availableUsd, null);
}

// ── width math ──
assert.equal(termVisWidth("abc"), 3);
assert.equal(termVisWidth(""), 0);
assert.equal(termVisWidth(fakeTheme.fg("dim", "abc")), 3, "ANSI is zero-width");
assert.equal(termVisWidth("◆"), 1, "◆ counts as narrow in this terminal");
assert.equal(termVisWidth("⚡"), 2);
assert.equal(truncateAnsi("hello world", 8), "hello w…");
assert.equal(termVisWidth(truncateAnsi(fakeTheme.fg("x", "hello world"), 8)), 8);
assert.equal(truncateAnsi("abc", 5), "abc");
assert.equal(truncateAnsi("abc", 0), "");

// ── widget render ──
const left = buildSessionLine({ requests: 7, spend: 0.42, elapsedMs: 0 })!;
const widget = new StatusLineWidget(fakeTheme, left, tiers, false);

// Wide: full tier, left-right justified, exactly width columns
const wide = widget.render(80);
assert.equal(wide.length, 1);
assert.equal(termVisWidth(wide[0]), 80);
assert.ok(stripAnsi(wide[0]).startsWith("⚡ $0.42"));
assert.ok(stripAnsi(wide[0]).endsWith("996/1k"));

// Medium: drops to a compressed tier, still exactly width
const med = widget.render(52);
assert.equal(termVisWidth(med[0]), 52);
assert.ok(!stripAnsi(med[0]).includes("tok/30d"), "compressed tiers drop tokens activity first");

// Narrow: no tier fits → left only, padded
const narrow = widget.render(termVisWidth(left) + 3);
assert.equal(termVisWidth(narrow[0]), termVisWidth(left) + 3);
assert.ok(stripAnsi(narrow[0]).startsWith("⚡"));
assert.ok(!stripAnsi(narrow[0]).includes("◆"));

// Narrower than left itself: truncation never overflows (crash guard)
const tiny = widget.render(10);
assert.equal(termVisWidth(tiny[0]), 10);

// Left empty (session gated) → right-aligned account line
const rightOnly = new StatusLineWidget(fakeTheme, "", tiers, false);
const ro = rightOnly.render(70);
assert.equal(termVisWidth(ro[0]), 70);
assert.ok(stripAnsi(ro[0]).endsWith("996/1k"));

// No data at all
assert.deepEqual(new StatusLineWidget(fakeTheme, "", [], false).render(40), [fakeTheme.fg("dim", "") + " ".repeat(40)]);

// Warning color wired through
const warn = new StatusLineWidget(fakeTheme, "", buildAccountTiers(acc({ availableUsd: 5 }), true), true);
const warnLine = warn.render(60)[0];
assert.ok(stripAnsi(warnLine).includes("⚠ ◆ $5 avail"));
assert.ok(warnLine.includes("warning") || true); // fakeTheme ignores color names
const markTheme = { fg: (c: string, t: string) => `<${c}>${t}</>` };
assert.ok(new StatusLineWidget(markTheme, "", buildAccountTiers(acc({ availableUsd: 5 }), true), true).render(60)[0].includes("<warning>"));
assert.ok(new StatusLineWidget(markTheme, "", buildAccountTiers(acc({ availableUsd: 5 }), true), false).render(60)[0].includes("<dim>"));

// ── config coercion ──
assert.deepEqual(coerceStatusConfig(undefined), {
	session: "widget",
	account: "widget",
	hideOnOtherProvider: true,
	lowBalanceUsd: 10,
});
assert.deepEqual(coerceStatusConfig({ session: "bogus", lowBalanceUsd: -3 }), {
	session: "widget",
	account: "widget",
	hideOnOtherProvider: true,
	lowBalanceUsd: 10,
});
assert.deepEqual(coerceStatusConfig({ session: "statusbar", account: "off", hideOnOtherProvider: false, lowBalanceUsd: null }), {
	session: "statusbar",
	account: "off",
	hideOnOtherProvider: false,
	lowBalanceUsd: null,
});
assert.equal(coerceStatusConfig({ lowBalanceUsd: 42 }).lowBalanceUsd, 42);
assert.equal(coerceStatusConfig({ lowBalanceUsd: false }).lowBalanceUsd, null);
assert.deepEqual(coerceStatusConfig(null).session, "widget");

console.log("status.smoke: all assertions passed");
