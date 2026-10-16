# Changelog

## 1.3.28

- Pin Pi SDK development dependencies to 1.3.0 while retaining wildcard host peers; verify real manifest loading, lifecycle and native/bundled Pi hosts offline.

## 1.3.27

- Pin Pi SDK development dependencies to 1.2.0 while retaining wildcard host peers; verify real manifest loading, lifecycle and native/bundled Pi hosts offline.

## 1.3.25

- Quiet startup sync: background `/api/cli/models` revalidation runs only with an API key, only when the disk cache is older than 1 hour (`PI_PROVIDER_SYNC_TTL_MS`, `0` = always), missing, or fetched with a different key (including a new `zro login`), and only in one pi process at a time (lock file next to the cache). Failed refreshes back off for 5 minutes; sessions that skip adopt a cache refreshed by another process.
- Never store the API key: key changes are detected via a salted sha256 fingerprint in `cache/zro-models.sync.json`. The cache file format is unchanged.
- Footer account prefetch at session start: skipped without a UI (`pi -p`, child agents) or with `account: "off"`, and shared across pi processes through `cache/zro-account.json` (60 s window, same lock/fingerprint rules). Post-run and model-switch balance polling also skip without a UI; `/zro-status refresh` still fetches.
- Write the model cache atomically and swallow API key resolution failures in `session_start`.
- Add vitest coverage for the sync policy and the session_start integration.

## 1.3.23

- Validate provider registration and session lifecycle against Pi 1.0.0; update the pinned development SDK.
- Probe concurrent native SDK streams and instrumentation without patching global fetch; include the probe in the standard check.

## 1.3.20

- Validate against Pi 0.99.0, including an offline real-host package-loading probe.
- Declare imported host packages as wildcard peers and pin development dependencies to Pi 0.99.0.
