const PATCH_ID = detectHostPackageId() ?? "pf2e_compendium_chn";
const BABEL_NAMESPACE = "babele";
const PATCH_NAMESPACE = PATCH_ID;
const SETTING_LOADING_MODE = "loadingMode";
const SETTING_LABELS = "labels";
const SETTING_TITLE_INDEX = "titleIndex";

const LOADING_MODES = {
  FULL: "full",
  ONDEMAND: "ondemand",
};

const DEFAULT_TRANSLATION_DIRS = ["zh-CN", "compendium"];
const LANGUAGE_ALIASES = ["cn", "zh-CN", "zh_Hans", "zh-Hans"];

let capturedBabele = null;
let patched = false;

log("module script loaded", { url: import.meta.url, patchId: PATCH_ID });

Hooks.on("babele.init", (babele) => {
  capturedBabele = babele;
  patchBabele28Facade(babele);
});

Hooks.once("init", () => {
  registerSettingsIfMissing();
  registerSettingsUiEnhancements();
  registerDatabaseWrapper();
  if (capturedBabele) patchBabele28Facade(capturedBabele);
});

Hooks.once("ready", () => {
  if (game.babele) patchBabele28Facade(game.babele);
  registerQuickInsertPatch();
  registerDebugApi();
});

function log(message, data = null) {
  try {
    if (data === null) console.info(`[${PATCH_ID}] ${message}`);
    else console.info(`[${PATCH_ID}] ${message}`, data);
  } catch (_) {}
}

function detectHostPackageId() {
  try {
    const url = new URL(import.meta.url);
    const match = url.pathname?.match?.(/\/(modules|systems|worlds)\/([^/]+)\//);
    return match?.[2] ?? null;
  } catch (_) {
    return null;
  }
}

function registerSettingsIfMissing() {
  const settings = game.settings?.settings;
  if (!settings) return;

  if (!settings.has(`${PATCH_NAMESPACE}.${SETTING_LOADING_MODE}`)) {
    game.settings.register(PATCH_NAMESPACE, SETTING_LOADING_MODE, {
      type: String,
      scope: "world",
      config: false,
      choices: {
        [LOADING_MODES.FULL]: "Full (traditional)",
        [LOADING_MODES.ONDEMAND]: "On-demand (fast startup)",
      },
      default: LOADING_MODES.ONDEMAND,
    });
  }

  if (!settings.has(`${BABEL_NAMESPACE}.${SETTING_LOADING_MODE}`)) {
    game.settings.register(BABEL_NAMESPACE, SETTING_LOADING_MODE, {
      name: "Babele 加载模式",
      hint: "全量模式使用 Babele 原生启动加载；轻量模式保留旧选项名，但内部改为适配 Babele 2.8+ 的按需翻译与轻量索引补丁，适合网络较差或启动较慢的环境。",
      type: String,
      scope: "world",
      config: true,
      choices: {
        [LOADING_MODES.FULL]: "全量模式（原生加载）",
        [LOADING_MODES.ONDEMAND]: "轻量模式（按需加载）",
      },
      default: getPatchLoadingModeSetting() ?? LOADING_MODES.ONDEMAND,
      onChange: (value) => {
        syncPatchLoadingModeSetting(value);
        window.location.reload();
      },
    });
  }

  if (!settings.has(`${BABEL_NAMESPACE}.${SETTING_LABELS}`)) {
    game.settings.register(BABEL_NAMESPACE, SETTING_LABELS, {
      type: Object,
      default: {},
      scope: "world",
      config: false,
    });
  }

  if (!settings.has(`${BABEL_NAMESPACE}.${SETTING_TITLE_INDEX}`)) {
    game.settings.register(BABEL_NAMESPACE, SETTING_TITLE_INDEX, {
      type: Object,
      default: {},
      scope: "world",
      config: false,
    });
  }
}

function getPatchLoadingModeSetting() {
  try {
    const mode = game.settings?.get?.(PATCH_NAMESPACE, SETTING_LOADING_MODE);
    return isValidLoadingMode(mode) ? mode : null;
  } catch (_) {
    return null;
  }
}

function getLoadingModeSetting() {
  try {
    const mode = game.settings?.get?.(BABEL_NAMESPACE, SETTING_LOADING_MODE);
    if (isValidLoadingMode(mode)) return mode;
  } catch (_) {}
  return getPatchLoadingModeSetting() ?? LOADING_MODES.ONDEMAND;
}

function syncPatchLoadingModeSetting(value) {
  if (!isValidLoadingMode(value)) return;
  try {
    if (game.settings?.get?.(PATCH_NAMESPACE, SETTING_LOADING_MODE) !== value) {
      void game.settings?.set?.(PATCH_NAMESPACE, SETTING_LOADING_MODE, value);
    }
  } catch (_) {}
}

function isValidLoadingMode(value) {
  return value === LOADING_MODES.FULL || value === LOADING_MODES.ONDEMAND;
}

function isOnDemandMode() {
  return getLoadingModeSetting() === LOADING_MODES.ONDEMAND;
}

function registerSettingsUiEnhancements() {
  Hooks.on("renderSettingsConfig", (_app, html) => {
    const root = html?.[0] ?? html;
    const select = root?.querySelector?.(`select[name="${BABEL_NAMESPACE}.${SETTING_LOADING_MODE}"]`);
    if (!select || select.dataset.pf2eCompendiumChnEnhanced === "1") return;
    select.dataset.pf2eCompendiumChnEnhanced = "1";

    const note = document.createElement("p");
    note.className = "notes";
    note.textContent = "轻量模式保留旧选项名；在 Babele 2.8+ 下会避免启动时全量应用合集翻译，改为打开/搜索时按需补翻译与标题索引。";
    select.closest?.(".form-group")?.append?.(note);
  });
}

function patchBabele28Facade(babele) {
  if (!babele) return;
  const state = ensureState(babele);
  if (state.facadePatched) return;
  state.facadePatched = true;

  if (typeof babele.init === "function") {
    state.originalInit = babele.init.bind(babele);
    babele.init = async (callbackOrOptions = {}) => {
      if (!isOnDemandMode()) return state.originalInit(callbackOrOptions);
      await initializeLightweightMode(babele, state);
      return true;
    };
  }

  babele.isFullMode = () => !isOnDemandMode();
  babele.loadLabels = async () => {
    state.labels = await loadLabels(state);
    return state.labels;
  };
  babele.loadTitleIndex = async () => {
    state.titleIndex = await loadTitleIndex(state);
    return state.titleIndex;
  };
  babele.applyLabels = (labels = null) => applyLabels(labels ?? state.labels);
  babele.applyTitleIndex = (titleIndex = null) => {
    state.titleIndex = titleIndex ?? state.titleIndex ?? {};
  };
  babele.ensurePackTranslationsLoaded = async (packId) => ensurePackTranslationsLoaded(babele, state, packId);

  patched = true;
  log("patched Babele 2.8+ facade for lightweight mode");
}

function ensureState(babele = game.babele) {
  const state = babele.__pf2eCompendiumChn28 ?? {};
  babele.__pf2eCompendiumChn28 = state;
  state.lightweightInitialized ??= false;
  state.dataLoadedCalled ??= false;
  state.labels ??= null;
  state.titleIndex ??= null;
  state.packTranslations ??= new Map();
  state.mappedCompendiums ??= new foundry.utils.Collection();
  state.loadingPacks ??= new Map();
  state.translationFiles ??= null;
  state.MappedCompendium ??= null;
  state.CompendiumRuntime ??= null;
  return state;
}

async function initializeLightweightMode(babele, state) {
  if (state.lightweightInitialized) return;
  state.lightweightInitialized = true;

  try {
    state.labels = await loadLabels(state);
    applyLabels(state.labels);
    if (game.user?.isGM) await game.settings?.set?.(BABEL_NAMESPACE, SETTING_LABELS, state.labels);
  } catch (error) {
    console.warn(`[${PATCH_ID}] labels.json was not loaded in lightweight mode.`, error);
  }

  try {
    state.titleIndex = await loadTitleIndex(state);
    if (game.user?.isGM) await game.settings?.set?.(BABEL_NAMESPACE, SETTING_TITLE_INDEX, state.titleIndex);
  } catch (error) {
    state.titleIndex = {};
    console.warn(`[${PATCH_ID}] titles.json was not loaded in lightweight mode.`, error);
  }

  if (!state.dataLoadedCalled) {
    state.dataLoadedCalled = true;
    Hooks.callAll("babele.dataLoaded");
  }
}

function getTranslationDirectories() {
  const dirs = [];
  for (const dir of DEFAULT_TRANSLATION_DIRS) dirs.push(`modules/${PATCH_ID}/${dir}`);
  try {
    const configured = game.settings?.get?.(BABEL_NAMESPACE, "directory");
    const lang = game.settings?.get?.("core", "language");
    if (configured?.trim?.()) dirs.push(`${configured.trim()}/${lang}`);
  } catch (_) {}
  return [...new Set(dirs)];
}

async function fetchJson(url, { silent404 = true } = {}) {
  try {
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) {
      if (!(silent404 && response.status === 404)) console.warn(`[${PATCH_ID}] Failed to fetch ${url}: ${response.status}`);
      return null;
    }
    return await response.json();
  } catch (error) {
    if (!silent404) console.warn(`[${PATCH_ID}] Failed to fetch ${url}.`, error);
    return null;
  }
}

async function loadLabels(state = ensureState()) {
  if (state.labels) return state.labels;
  for (const dir of getTranslationDirectories()) {
    const data = await fetchJson(`${dir}/labels.json`);
    if (data) return data;
  }
  try {
    return game.settings?.get?.(BABEL_NAMESPACE, SETTING_LABELS) ?? {};
  } catch (_) {
    return {};
  }
}

async function loadTitleIndex(state = ensureState()) {
  if (state.titleIndex) return state.titleIndex;
  for (const dir of getTranslationDirectories()) {
    const data = await fetchJson(`${dir}/titles.json`);
    if (data) return data;
  }
  try {
    return game.settings?.get?.(BABEL_NAMESPACE, SETTING_TITLE_INDEX) ?? {};
  } catch (_) {
    return {};
  }
}

function applyLabels(labels = {}) {
  if (!labels || typeof labels !== "object") return;
  for (const [collection, label] of Object.entries(labels)) {
    const pack = game.packs?.get?.(collection);
    if (!pack || !label) continue;
    pack.metadata.label = label;
    pack.title = label;
  }
}

function normalizePackId(pack) {
  if (!pack) return null;
  if (typeof pack === "string") return pack;
  if (typeof pack.collection === "string") return pack.collection;
  if (typeof pack.metadata?.id === "string") return pack.metadata.id;
  if (typeof pack.metadata?.packageName === "string" && typeof pack.metadata?.name === "string") {
    return `${pack.metadata.packageName}.${pack.metadata.name}`;
  }
  return null;
}

function packMetadataFor(packId) {
  const pack = game.packs?.get?.(packId);
  if (pack?.metadata) return pack.metadata;
  return (game.data?.packs ?? []).find((metadata) => collectionFromMetadata(metadata) === packId) ?? null;
}

function collectionFromMetadata(metadata) {
  if (!metadata) return null;
  const prefix = metadata.packageType === "world" ? "world" : metadata.packageName;
  return prefix && metadata.name ? `${prefix}.${metadata.name}` : metadata.id ?? null;
}

async function importBabeleClass(path, exportName) {
  try {
    const module = await import(path);
    return module?.[exportName] ?? null;
  } catch (error) {
    console.warn(`[${PATCH_ID}] Could not import ${exportName} from ${path}.`, error);
    return null;
  }
}

async function ensureBabeleClasses(state) {
  if (!state.MappedCompendium) {
    state.MappedCompendium = await importBabeleClass("/modules/babele/script/compendium/mapped-compendium.js", "MappedCompendium");
  }
  if (!state.CompendiumRuntime) {
    state.CompendiumRuntime = await importBabeleClass("/modules/babele/script/compendium/compendium-runtime.js", "CompendiumRuntime");
  }
  return !!state.MappedCompendium;
}

async function loadPackTranslation(packId) {
  const encoded = encodeURI(packId);
  for (const dir of getTranslationDirectories()) {
    const data = await fetchJson(`${dir}/${encoded}.json`);
    if (data) return data;
  }
  return null;
}

async function ensurePackTranslationsLoaded(babele, state, packId, stack = new Set()) {
  if (!packId) return null;
  if (state.mappedCompendiums.has(packId)) return state.mappedCompendiums.get(packId);
  if (state.loadingPacks.has(packId)) return state.loadingPacks.get(packId);
  if (stack.has(packId)) return null;

  const promise = (async () => {
    stack.add(packId);
    const translation = await loadPackTranslation(packId);
    if (!translation) return null;

    if (Array.isArray(translation.reference)) {
      for (const ref of translation.reference) await ensurePackTranslationsLoaded(babele, state, ref, stack);
    } else if (typeof translation.reference === "string") {
      await ensurePackTranslationsLoaded(babele, state, translation.reference, stack);
    }

    const metadata = packMetadataFor(packId);
    if (!metadata) return null;
    if (!await ensureBabeleClasses(state)) return null;

    const documentMappings = babele.documentMappings;
    if (!documentMappings?.supports?.(metadata.type)) return null;

    const mapped = new state.MappedCompendium(metadata, translation, {
      translationStrategies: babele.translationMatchStrategies?.() ?? [],
      documentMappings,
      language: game.settings?.get?.("core", "language"),
      runtimeFactory: () => new state.CompendiumRuntime({ globalPacks: state.mappedCompendiums }),
    });

    state.packTranslations.set(packId, translation);
    state.mappedCompendiums.set(packId, mapped);
    return mapped;
  })();

  state.loadingPacks.set(packId, promise);
  try {
    return await promise;
  } finally {
    state.loadingPacks.delete(packId);
  }
}

function titleFor(packId, originalName, state = ensureState()) {
  if (!packId || !originalName) return null;
  const entry = state.titleIndex?.[packId];
  return entry?.titles?.[originalName] ?? null;
}

function translateIndexTitles(state, index, packId) {
  if (!Array.isArray(index) || !packId) return index;
  for (const entry of index) {
    const translated = titleFor(packId, entry?.name, state);
    if (translated) {
      entry.flags = foundry.utils.mergeObject(entry.flags ?? {}, { babele: { originalName: entry.name } }, { inplace: false });
      entry.name = translated;
    }
  }
  return index;
}

function documentSource(document) {
  if (!document) return null;
  if (typeof document.toObject === "function") return document.toObject();
  if (typeof document.toJSON === "function") return document.toJSON();
  return document;
}

function translateDocumentWithMappedCompendium(document, mapped, state, packId) {
  const source = documentSource(document);
  if (!source || !mapped) return document;
  try {
    return mapped.translate(source, false, { globalPacks: state.mappedCompendiums });
  } catch (error) {
    console.warn(`[${PATCH_ID}] Failed to translate document from ${packId}.`, error);
    return document;
  }
}

function registerDatabaseWrapper() {
  if (!game.modules?.get?.("lib-wrapper")?.active) {
    if (game.user?.isGM) ui.notifications?.error?.(`${PATCH_ID}: libWrapper is required.`);
    return;
  }

  libWrapper.register(
    PATCH_ID,
    "CONFIG.DatabaseBackend._getDocuments",
    async function (wrapped, ...args) {
      const result = await wrapped(...args);
      if (!isOnDemandMode() || !Array.isArray(result) || !result.length) return result;

      const babele = game.babele;
      if (!babele) return result;
      const state = ensureState(babele);
      await initializeLightweightMode(babele, state);

      const request = args?.[1] ?? {};
      const packId = normalizePackId(request.pack);
      if (!packId) return result;

      const isIndex = !!(request.index ?? request.options?.index);
      if (isIndex) return translateIndexTitles(state, result, packId);

      const mapped = await ensurePackTranslationsLoaded(babele, state, packId);
      if (!mapped?.translated) return result;
      return result.map((document) => translateDocumentWithMappedCompendium(document, mapped, state, packId));
    },
    "WRAPPER",
  );
}

function registerQuickInsertPatch() {
  const patch = async (qi = globalThis.QuickInsert) => {
    if (!isOnDemandMode()) return;
    const babele = game.babele;
    if (!babele) return;
    const state = ensureState(babele);
    await initializeLightweightMode(babele, state);
    patchQuickInsertIndex(qi, state);
  };

  Hooks.on("QuickInsert:IndexCompleted", patch);
  Hooks.on("quickInsert.indexCompleted", patch);
  setTimeout(() => patch(), 500);
  setTimeout(() => patch(), 3000);
}

function patchQuickInsertIndex(qi, state = ensureState()) {
  const seen = new WeakSet();
  const roots = [qi, globalThis.QuickInsert, game?.quickInsert].filter(Boolean);
  let changed = 0;

  const visit = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 6 || seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) changed += patchQuickInsertItem(item, state) ? 1 : 0;
      for (const item of value) visit(item, depth + 1);
      return;
    }

    if (value instanceof Map || value instanceof foundry.utils.Collection) {
      for (const item of value.values()) changed += patchQuickInsertItem(item, state) ? 1 : 0;
      for (const item of value.values()) visit(item, depth + 1);
      return;
    }

    changed += patchQuickInsertItem(value, state) ? 1 : 0;
    for (const key of ["items", "index", "searchIndex", "documents", "entries", "data", "collection", "_index", "_items"]) {
      if (value[key]) visit(value[key], depth + 1);
    }
  };

  for (const root of roots) visit(root);
  if (changed) log("patched Quick Insert translated titles", { changed });
  return changed;
}

function patchQuickInsertItem(item, state) {
  if (!item || typeof item !== "object") return false;
  const packId = normalizePackId(item.pack ?? item.compendium ?? item.collection ?? item.packId ?? item.document?.pack);
  const originalName = item.originalName ?? item.name ?? item.item?.name ?? item.document?.name;
  const translated = titleFor(packId, originalName, state);
  if (!translated || translated === item.name) return false;

  item.originalName ??= originalName;
  item.name = translated;
  item.searchText = `${translated} ${originalName}`;
  if (item.item && typeof item.item === "object") item.item.name = translated;
  if (item.document && typeof item.document === "object") item.document.name = translated;
  return true;
}

function registerDebugApi() {
  game.pf2eCompendiumChn = game.pf2eCompendiumChn ?? {};
  Object.assign(game.pf2eCompendiumChn, {
    loadLabels: async () => game.babele?.loadLabels?.(),
    loadTitleIndex: async () => game.babele?.loadTitleIndex?.(),
    getTitle: (packId, name) => titleFor(packId, name, ensureState(game.babele)),
    ensurePackTranslationsLoaded: async (packId) => game.babele?.ensurePackTranslationsLoaded?.(packId),
    patchQuickInsertIndex: () => patchQuickInsertIndex(globalThis.QuickInsert, ensureState(game.babele)),
    state: () => ensureState(game.babele),
  });
}
