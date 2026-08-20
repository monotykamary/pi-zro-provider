#!/usr/bin/env node
/**
 * Zro model catalog sync.
 *
 * Fetches the live model catalog from https://zro.moonmath.ai/api/cli/models
 * (the same endpoint the zro CLI uses), writes models.json, moves delisted
 * models into deprecated-models.json, and regenerates the README model table.
 *
 * Requires a credential, resolved in order:
 *   1. ZRO_API_KEY environment variable
 *   2. ~/.config/zro/credentials.json (written by `zro login`)
 *
 * Usage:
 *   node scripts/update-models.js
 *   ZRO_API_KEY=your-key node scripts/update-models.js
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS_JSON_PATH = path.join(PROJECT_ROOT, 'models.json');
const README_PATH = path.join(PROJECT_ROOT, 'README.md');
const PATCH_JSON_PATH = path.join(PROJECT_ROOT, 'patch.json');
const CUSTOM_MODELS_JSON_PATH = path.join(PROJECT_ROOT, 'custom-models.json');

const ENDPOINT_ROOT = (process.env.ZRO_ENDPOINT_ROOT || 'https://zro.moonmath.ai').replace(/\/+$/, '');
const MODELS_API_URL = `${ENDPOINT_ROOT}/api/cli/models`;

const AUTH_JSON_PATH = path.join(os.homedir(), '.config', 'zro', 'credentials.json');

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

function resolveApiKey() {
  if (process.env.ZRO_API_KEY) return process.env.ZRO_API_KEY;
  const configRoot = process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, 'zro')
    : path.join(os.homedir(), '.config', 'zro');
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(configRoot, 'credentials.json'), 'utf8'));
    if (parsed && typeof parsed.apiKey === 'string' && parsed.apiKey.trim()) return parsed.apiKey;
  } catch { /* None stored yet */ }
  return null;
}

// ─── Patch application (same pipeline as index.ts) ────────────────────────────

function applyPatch(model, patch) {
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

function buildModels(baseModels, customModels, patchData) {
  const modelMap = new Map();
  for (const model of baseModels) modelMap.set(model.id, model);
  for (const [id, patchEntry] of Object.entries(patchData)) {
    const existing = modelMap.get(id);
    if (existing) modelMap.set(id, applyPatch(existing, patchEntry));
  }
  for (const model of customModels) {
    const existing = modelMap.get(model.id);
    const patchEntry = patchData[model.id];
    if (existing && patchEntry) modelMap.set(model.id, applyPatch(model, patchEntry));
    else if (existing) modelMap.set(model.id, model);
    else if (patchEntry) modelMap.set(model.id, applyPatch(model, patchEntry));
    else modelMap.set(model.id, model);
  }
  return Array.from(modelMap.values());
}

// ─── Model transformation ─────────────────────────────────────────────────────

const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

// Builds the thinkingLevelMap zro's own pi adapter writes: each catalog
// reasoning level maps its piLevel (off|minimal|low|medium|high|xhigh) to the
// id the inference proxy expects (e.g. glm-5.2 → { off: "none", high: "high",
// xhigh: "max" }). pi levels without a matching catalog level are null.
function buildThinkingLevelMap(levels) {
  const result = Object.fromEntries(PI_THINKING_LEVELS.map((level) => [level, null]));
  for (const level of levels) {
    if (level && typeof level.id === 'string' && level.id &&
        typeof level.piLevel === 'string' && result[level.piLevel] !== undefined) {
      result[level.piLevel] = level.id;
    }
  }
  return result;
}

function transformModel(apiModel) {
  const levels = Array.isArray(apiModel?.reasoning?.levels) ? apiModel.reasoning.levels : [];
  return {
    id: apiModel.id,
    name: apiModel.displayName || apiModel.id,
    reasoning: true,
    thinkingLevelMap: buildThinkingLevelMap(levels),
    input: ['text'],
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
      maxTokensField: 'max_tokens',
    },
  };
}

// ─── README generation ────────────────────────────────────────────────────────

function formatCost(cost) {
  if (cost === 0 || cost === null || cost === undefined) return '—';
  return '$' + cost.toFixed(2);
}

function formatNumber(num) {
  if (num === null || num === undefined) return '-';
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${Math.round(num / 1000)}K`;
  return num.toString();
}

function getInputTypes(inputTypes) {
  const types = inputTypes || ['text'];
  if (types.includes('image') && types.includes('text')) return 'Text + Image';
  if (types.includes('image')) return 'Image';
  return 'Text';
}

function generateReadmeRow(model) {
  const cost = model.cost || {};
  return `| ${model.name} | ${getInputTypes(model.input)} | ${formatNumber(model.contextWindow)} | ${formatNumber(model.maxTokens)} | ${formatCost(cost.input)} | ${formatCost(cost.output)} |`;
}

function updateReadme(models) {
  let readme = fs.readFileSync(README_PATH, 'utf8');

  const sortedModels = [...models].sort((a, b) => a.name.localeCompare(b.name));
  const tableRows = sortedModels.map(generateReadmeRow).join('\n');
  const newTable = `| Model | Type | Context | Max Tokens | Input Cost | Output Cost |
|-------|------|---------|------------|------------|-------------|
${tableRows}`;

  const tableRegex = /\| Model \| Type \| Context \| Max Tokens \| Input Cost \| Output Cost \|[\s\S]*?(?=\n\*Costs are per million)/;
  readme = readme.replace(tableRegex, newTable);

  readme = readme.replace(/\*\*\d+\+ AI Models\*\*/, `**${models.length}+ AI Models**`);

  fs.writeFileSync(README_PATH, readme);
  console.log(`✓ Updated README.md with ${models.length} models`);
}

// ─── Deprecated-model reconciliation ──────────────────────────────────────────

const DEPRECATED_MODEL_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Reconcile deprecated-models.json against the freshly fetched model list.
 * - in old models.json but not the API: moved into the deprecated file
 *   (deprecatedAt = now; preserved on repeat runs so the grace clock is not reset)
 * - back in the API: resurrected (dropped from the deprecated file)
 * - deprecatedAt older than 14 days: evicted permanently
 * Must run BEFORE the new models.json is written; it reads the old file itself.
 */
function updateDeprecatedModels(modelsJsonPath, newModels) {
  const deprecatedPath = path.join(path.dirname(modelsJsonPath), 'deprecated-models.json');

  let oldModels = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(modelsJsonPath, 'utf8'));
    if (Array.isArray(parsed)) oldModels = parsed;
  } catch { /* first run: no previous models.json */ }

  let deprecated = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(deprecatedPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) deprecated = parsed;
  } catch { /* no graveyard yet */ }

  const currentIds = new Set(newModels.map(m => m.id));
  const now = new Date().toISOString();
  const added = [];
  const resurrected = [];
  const evicted = [];

  for (const old of oldModels) {
    if (old && old.id && !currentIds.has(old.id) && !deprecated[old.id]) {
      deprecated[old.id] = { ...old, deprecatedAt: now };
      added.push(old.id);
    }
  }

  for (const [id, entry] of Object.entries(deprecated)) {
    if (currentIds.has(id)) {
      delete deprecated[id];
      resurrected.push(id);
      continue;
    }
    const removedAt = Date.parse(entry && entry.deprecatedAt ? entry.deprecatedAt : '');
    if (Number.isNaN(removedAt) || Date.now() - removedAt > DEPRECATED_MODEL_TTL_MS) {
      delete deprecated[id];
      evicted.push(id);
    }
  }

  if (added.length > 0 || resurrected.length > 0 || evicted.length > 0) {
    fs.writeFileSync(deprecatedPath, JSON.stringify(deprecated, null, 2) + '\n');
    console.log('Updated deprecated-models.json ' + JSON.stringify({ added, resurrected, evicted }));
  }
}

/**
 * Grace-period deprecated models (deprecatedAt within TTL) with metadata stripped.
 * Keeps the README table serving models that are delisted but still within their
 * 14-day grace window.
 */
function withDeprecatedForReadme(models) {
  const deprecatedPath = path.join(PROJECT_ROOT, 'deprecated-models.json');
  let deprecated = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(deprecatedPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) deprecated = parsed;
  } catch { /* no graveyard yet */ }
  const now = Date.now();
  const seen = new Set(models.map(m => m.id));
  const extras = [];
  for (const entry of Object.values(deprecated)) {
    if (!entry || !entry.id || seen.has(entry.id)) continue;
    const removedAt = Date.parse(entry.deprecatedAt || '');
    if (Number.isNaN(removedAt) || now - removedAt > DEPRECATED_MODEL_TTL_MS) continue;
    const m = { ...entry };
    delete m.deprecatedAt;
    extras.push(m);
  }
  return extras.length > 0 ? [...models, ...extras] : models;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.error('Error: No API key found. Run `zro login` first, or set ZRO_API_KEY.');
    console.error('Usage: ZRO_API_KEY=your-key node scripts/update-models.js');
    process.exit(1);
  }

  console.log(`Fetching models from ${MODELS_API_URL}...`);

  try {
    const response = await fetch(MODELS_API_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const apiResponse = await response.json();
    const apiModels = Array.isArray(apiResponse)
      ? apiResponse
      : (apiResponse.models || apiResponse.data || []);

    if (!Array.isArray(apiModels)) {
      throw new Error('API response does not contain an array of models');
    }

    console.log(`✓ Fetched ${apiModels.length} models from API`);

    // Load existing models.json — source of truth for curated specs
    let existingModels = [];
    try {
      existingModels = JSON.parse(fs.readFileSync(MODELS_JSON_PATH, 'utf8'));
    } catch {
      // File might not exist yet
    }
    const existingModelsMap = {};
    for (const m of existingModels) {
      existingModelsMap[m.id] = m;
    }

    // Transform models from API. The live catalog is authoritative for
    // context/output limits; curated name/thinkingLevelMap/compat wins.
    const apiTransformed = apiModels
      .map(m => ({ ...transformModel(m), ...(existingModelsMap[m.id] ?? {}) }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Load patch overrides for README rendering.
    const patch = loadJson(PATCH_JSON_PATH);

    // Update models.json — curated API data
    // Move delisted models to deprecated-models.json BEFORE models.json is overwritten
    updateDeprecatedModels(MODELS_JSON_PATH, apiTransformed);
    fs.writeFileSync(MODELS_JSON_PATH, JSON.stringify(apiTransformed, null, 2) + '\n');
    console.log(`✓ Updated models.json (${apiTransformed.length} models)`);

    // Load custom-models.json
    const customModels = Array.isArray(loadJson(CUSTOM_MODELS_JSON_PATH))
      ? loadJson(CUSTOM_MODELS_JSON_PATH)
      : [];

    // Check for custom models now available upstream (remove duplicates)
    const upstreamIds = new Set(apiTransformed.map(m => m.id));
    const duplicates = customModels.filter(m => upstreamIds.has(m.id));
    if (duplicates.length > 0) {
      console.log(`\nFound ${duplicates.length} custom model(s) now available upstream:`);
      for (const dup of duplicates) {
        console.log(`  - ${dup.id} (${dup.name})`);
      }
      const cleaned = customModels.filter(m => !upstreamIds.has(m.id));
      saveJson(CUSTOM_MODELS_JSON_PATH, cleaned);
      console.log(`✓ Removed ${duplicates.length} duplicate(s) from custom-models.json`);
      customModels.length = 0;
      customModels.push(...cleaned);
    }

    // Build merged models with patches for README
    const readmeModels = buildModels(withDeprecatedForReadme(apiTransformed), customModels, patch);
    readmeModels.sort((a, b) => a.name.localeCompare(b.name));

    // Update README
    updateReadme(readmeModels);

    // Summary
    console.log('\n--- Summary ---');
    console.log(`Total models: ${readmeModels.length}`);
    console.log(`Reasoning models: ${readmeModels.filter(m => m.reasoning).length}`);
    console.log(`Vision models: ${readmeModels.filter(m => m.input.includes('image')).length}`);

    const newIds = new Set(apiTransformed.map(m => m.id));
    const oldIds = new Set(existingModels.map(m => m.id));

    const added = [...newIds].filter(id => !oldIds.has(id));
    const removed = [...oldIds].filter(id => !newIds.has(id));

    if (added.length > 0) console.log(`\nNew models: ${added.join(', ')}`);
    if (removed.length > 0) console.log(`\nRemoved models: ${removed.join(', ')}`);

    console.log('\nDone!');
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
