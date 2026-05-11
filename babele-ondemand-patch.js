const PATCH_ID = detectHostPackageId() ?? "babele-ondemand-patch";

const BABEL_NAMESPACE = "babele";
const PATCH_NAMESPACE = PATCH_ID;
const SETTING_LOADING_MODE = "loadingMode";
const SETTING_LABELS = "labels";
const SETTING_TITLE_INDEX = "titleIndex";

const LOADING_MODES = {
  FULL: "full",
  ONDEMAND: "ondemand",
};

const NPC_TRANSLATOR_CONVERTERS = new Set([
  "npc-portrait-path",
  "npc-token-translation",
  "npc-data-translation",
  "npc-item-translation",
]);

const NPC_TRANSLATOR_DEP_PACKS = [
  "pf2e.spells-srd",
  "pf2e.bestiary-ability-glossary-srd",
  "pf2e.conditionitems",
  "pf2e.actionspf2e",
  "pf2e.feats-srd",
  "pf2e.classfeatures",
  "pf2e.ancestryfeatures",
  "pf2e.ancestries",
  "pf2e.heritages",
  "pf2e.classes",
  "pf2e.backgrounds",
  "pf2e.deities",
  "pf2e.equipment-srd",
];

const ACTOR_IMPORT_DEBUG_DEFAULT = false;
const PATCH_TRACE_DEFAULT = true;
const PATCH_FETCH_TRACE_DEFAULT = true;
const ACTOR_IMPORT_INTERNAL_OPTION = "__babeleOnDemandActorImportTranslate";

let capturedBabele = null;
let patched = false;

const __patchDebugRoot = globalThis.BabeleOnDemandPatchDebug ?? (globalThis.BabeleOnDemandPatchDebug = {});
if (typeof __patchDebugRoot.actorImport !== "boolean") __patchDebugRoot.actorImport = ACTOR_IMPORT_DEBUG_DEFAULT;
if (typeof __patchDebugRoot.trace !== "boolean") __patchDebugRoot.trace = PATCH_TRACE_DEFAULT;
if (typeof __patchDebugRoot.fetchTrace !== "boolean") __patchDebugRoot.fetchTrace = PATCH_FETCH_TRACE_DEFAULT;

logPatch("module script loaded", { url: import.meta.url, patchId: PATCH_ID });

function logPatch(message, data = null) {
  try {
    if (data !== null) console.info(`[${PATCH_ID}] ${message}`, data);
    else console.info(`[${PATCH_ID}] ${message}`);
  } catch {
  }
}

function tracePatch(message, data = null, { stack = false } = {}) {
  if (!globalThis?.BabeleOnDemandPatchDebug?.trace) return;
  try {
    if (data !== null) console.info(`[${PATCH_ID}] [Trace] ${message}`, data);
    else console.info(`[${PATCH_ID}] [Trace] ${message}`);
    if (stack) {
      console.trace(`[${PATCH_ID}] [TraceStack] ${message}`);
    }
  } catch {
  }
}

function snapshotPatchState(babele, state = babele?.__ondemandPatch) {
  return {
    apiLevel: state?.apiLevel ?? null,
    loadingMode: safeReadLoadingModeSettings(),
    patched: !!state?.patched,
    initialized: !!babele?.initialized,
    globalMappingsLoaded: !!state?.globalMappingsLoaded,
    labelsCount: Object.keys(state?.labels ?? {}).length,
    titleIndexCollections: Object.keys(state?.titleIndex ?? {}).length,
    translationFilesCached: Array.isArray(state?.translationFilesCache) ? state.translationFilesCache.length : 0,
    mappingFilesCached: Array.isArray(state?.mappingFilesCache) ? state.mappingFilesCache.length : 0,
    packTranslationUrlEntries: state?.packTranslationUrls?.size ?? 0,
    packTranslationsLoading: state?.packTranslationsLoading?.size ?? 0,
    loadedPacks: state?.loadedPacks?.size ?? 0,
    lightMappedPacks: state?.lightMappedPacks?.size ?? 0,
    compatPacks: state?.compatPacks?.size ?? 0,
    lightRuntimeApplied: !!state?.lightRuntimeApplied,
  };
}

function safeReadLoadingModeSettings() {
  try {
    return {
      babele: game.settings?.get?.(BABEL_NAMESPACE, SETTING_LOADING_MODE) ?? null,
      patch: game.settings?.get?.(PATCH_NAMESPACE, SETTING_LOADING_MODE) ?? null,
    };
  } catch {
    return {
      babele: null,
      patch: null,
    };
  }
}

function classifyJsonUrl(url) {
  const value = String(url ?? "");
  if (!/\.json(?:$|[?#])/i.test(value)) return null;
  if (/(^|\/)labels\.json(?:$|[?#])/i.test(value)) return "labels";
  if (/(^|\/)titles\.json(?:$|[?#])/i.test(value)) return "titles";
  if (/(^|\/)mappings?\.json(?:$|[?#])/i.test(value)) return "mapping";
  if (/(modules|systems|worlds)\//i.test(value)) return "pack";
  return "json";
}

function installFetchDiagnostics() {
  const root = globalThis;
  if (root.__BabeleOnDemandPatchFetchWrapped) return;
  if (typeof root.fetch !== "function") return;

  const originalFetch = root.fetch.bind(root);
  root.__BabeleOnDemandPatchFetchWrapped = true;
  root.__BabeleOnDemandPatchOriginalFetch = originalFetch;
  root.__BabeleOnDemandPatchFetchSeen = root.__BabeleOnDemandPatchFetchSeen ?? new Set();
  root.__BabeleOnDemandPatchFetchCounts = root.__BabeleOnDemandPatchFetchCounts ?? new Map();

  root.fetch = async (...args) => {
    const url = args?.[0]?.url ?? args?.[0];
    const kind = classifyJsonUrl(url);
    const shouldTrace = !!kind && !!root?.BabeleOnDemandPatchDebug?.fetchTrace;
    const key = `${kind ?? "other"}::${String(url)}`;
    const count = (root.__BabeleOnDemandPatchFetchCounts.get(key) ?? 0) + 1;
    root.__BabeleOnDemandPatchFetchCounts.set(key, count);
    const firstSeen = !root.__BabeleOnDemandPatchFetchSeen.has(key);
    if (firstSeen) root.__BabeleOnDemandPatchFetchSeen.add(key);
    if (shouldTrace) {
      if (firstSeen || count === 10 || count === 100 || count % 500 === 0) {
        tracePatch("fetch:start", {
          kind,
          url: String(url),
          count,
        }, { stack: firstSeen });
      }
    }

    const started = Date.now();
    try {
      const response = await originalFetch(...args);
      if (shouldTrace) {
        if (firstSeen || count === 10 || count === 100 || count % 500 === 0) {
          tracePatch("fetch:done", {
            kind,
            url: String(url),
            count,
            ok: response?.ok ?? null,
            status: response?.status ?? null,
            elapsedMs: Date.now() - started,
          });
        }
      }
      return response;
    } catch (error) {
      if (shouldTrace) {
        tracePatch("fetch:error", {
          kind,
          url: String(url),
          count,
          elapsedMs: Date.now() - started,
          error: error?.message ?? String(error),
        });
      }
      throw error;
    }
  };

  tracePatch("fetch diagnostics installed");
}

function detectBabeleApiLevel(babele) {
  if (!babele) return "unknown";
  const hasModernFacade =
    typeof babele.mappedCompendiumFor === "function" ||
    typeof babele.translatedCompendiumFor === "function" ||
    !!babele.documentMappings ||
    !!babele.converterRegistry ||
    typeof babele.identityExtractorRegistry === "function";
  if (hasModernFacade) return "modern";
  return "legacy";
}

function isMappingFileName(fileName) {
  const name = getBaseName(fileName).toLowerCase();
  return name === "mappings.json" || name === "mapping.json";
}

function orderTranslationSources({ system = [], modules = [], configured = [] } = {}) {
  return [...system, ...modules, ...configured].filter((value) => typeof value === "string" && value.length);
}

function sortMappingFilesByDirectoryPreference(files = []) {
  return [...files].sort((a, b) => {
    const dirA = getDirName(a);
    const dirB = getDirName(b);
    if (dirA !== dirB) return dirA.localeCompare(dirB);
    const nameA = getBaseName(a).toLowerCase();
    const nameB = getBaseName(b).toLowerCase();
    if (nameA === nameB) return 0;
    if (nameA === "mappings.json") return -1;
    if (nameB === "mappings.json") return 1;
    return nameA.localeCompare(nameB);
  });
}

function mergeTranslationPayloads(payloads) {
  let translation = null;
  for (const payload of (payloads ?? []).filter(Boolean)) {
    if (!translation) {
      translation = foundry.utils?.deepClone ? foundry.utils.deepClone(payload) : JSON.parse(JSON.stringify(payload));
      continue;
    }

    translation.label = payload.label ?? translation.label;

    if (payload.entries) {
      if (Array.isArray(translation.entries) || Array.isArray(payload.entries)) {
        const a = Array.isArray(translation.entries) ? translation.entries : [];
        const b = Array.isArray(payload.entries) ? payload.entries : [];
        translation.entries = a.concat(b);
      } else {
        translation.entries = { ...(translation.entries ?? {}), ...payload.entries };
      }
    }

    if (payload.mapping) translation.mapping = { ...(translation.mapping ?? {}), ...payload.mapping };
    if (payload.folders) translation.folders = { ...(translation.folders ?? {}), ...payload.folders };

    if (payload.types) {
      const a = Array.isArray(translation.types) ? translation.types : [];
      const b = Array.isArray(payload.types) ? payload.types : [];
      translation.types = Array.from(new Set(a.concat(b)));
    }

    if (payload.reference) {
      const a = translation.reference ? (Array.isArray(translation.reference) ? translation.reference : [translation.reference]) : [];
      const b = Array.isArray(payload.reference) ? payload.reference : [payload.reference];
      translation.reference = Array.from(new Set(a.concat(b)));
    }
  }
  return translation;
}

function getBaseName(fileName) {
  return String(fileName ?? "").split("/").pop().split("\\").pop();
}

function getDirName(fileName) {
  const value = String(fileName ?? "");
  const slash = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return slash >= 0 ? value.slice(0, slash) : "";
}

function detectHostPackageId() {
  try {
    const url = new URL(import.meta.url);
    const path = url.pathname ?? "";
    const match = path.match(/\/(modules|systems|worlds)\/([^/]+)\//);
    return match?.[2] || null;
  } catch {
    return null;
  }
}

Hooks.on("babele.init", (babele) => {
  logPatch("babele.init hook received");
  capturedBabele = babele;
  tryPatchBabele(babele);
});

Hooks.once("init", () => {
  logPatch("init hook: registering settings and wrappers");
  registerSettingsIfMissing();
  registerSettingsUiEnhancements();
  registerWrappers();

  if (capturedBabele) {
    tryPatchBabele(capturedBabele);
  }
});

Hooks.once("ready", () => {
  logPatch("ready hook", { patched, hasBabele: !!game.babele });
  installFetchDiagnostics();
  if (!patched && game.babele) {
    tryPatchBabele(game.babele);
  }
  registerDebugConsoleApi();
});

function registerSettingsIfMissing() {
  const settings = game.settings?.settings;
  if (!settings) return;

  registerPatchLoadingModeMigrationSettingIfMissing(settings);

  if (!settings.has(`${BABEL_NAMESPACE}.${SETTING_LOADING_MODE}`)) {
    game.settings.register(BABEL_NAMESPACE, SETTING_LOADING_MODE, {
      name: "Babele 加载模式",
      hint: "全量模式使用 Babele 原生启动加载；轻量模式只启动加载 labels/titles，并在打开具体合集包文档时按需加载完整翻译。",
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
    logPatch("registered visible Babele loading mode setting", { namespace: BABEL_NAMESPACE });
  } else {
    logPatch("Babele loading mode setting already registered", { namespace: BABEL_NAMESPACE });
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

function registerPatchLoadingModeMigrationSettingIfMissing(settings) {
  if (settings.has(`${PATCH_NAMESPACE}.${SETTING_LOADING_MODE}`)) return;
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

function getPatchLoadingModeSetting() {
  try {
    const mode = game.settings?.get?.(PATCH_NAMESPACE, SETTING_LOADING_MODE);
    return isValidLoadingMode(mode) ? mode : null;
  } catch {
    return null;
  }
}

function getLoadingModeSetting() {
  const raw = safeReadLoadingModeSettings();
  try {
    const mode = game.settings?.get?.(BABEL_NAMESPACE, SETTING_LOADING_MODE);
    if (isValidLoadingMode(mode)) return mode;
  } catch {
  }

  const fallback = getPatchLoadingModeSetting() ?? LOADING_MODES.ONDEMAND;
  tracePatch("loading mode fallback used", { raw, resolved: fallback });
  return fallback;
}

function syncPatchLoadingModeSetting(value) {
  if (!isValidLoadingMode(value)) return;
  try {
    if (game.settings?.get?.(PATCH_NAMESPACE, SETTING_LOADING_MODE) !== value) {
      void game.settings?.set?.(PATCH_NAMESPACE, SETTING_LOADING_MODE, value);
    }
  } catch {
  }
}

function isValidLoadingMode(value) {
  return value === LOADING_MODES.FULL || value === LOADING_MODES.ONDEMAND;
}

function registerSettingsUiEnhancements() {
  Hooks.on("renderSettingsConfig", (_app, html) => {
    try {
      enhanceLoadingModeSettingControl(html);
    } catch {
    }
  });
}

function enhanceLoadingModeSettingControl(html) {
  const root = html?.[0] ?? html?.element?.[0] ?? html?.element ?? html;
  if (!root?.querySelector) return;

  const select = root.querySelector(`select[name="${BABEL_NAMESPACE}.${SETTING_LOADING_MODE}"]`);
  if (!select) {
    logPatch("settings UI rendered but loading mode select was not found");
    return;
  }

  const formGroup = select.closest?.(".form-group") ?? select.parentElement;
  if (!formGroup || formGroup.dataset.babeleOndemandModeEnhanced) return;
  formGroup.dataset.babeleOndemandModeEnhanced = "true";

  select.style.display = "none";

  const buttonGroup = document.createElement("div");
  buttonGroup.className = "babele-ondemand-mode-toggle";
  buttonGroup.style.display = "flex";
  buttonGroup.style.gap = "0.5rem";
  buttonGroup.style.flexWrap = "wrap";

  const buttons = [
    { mode: LOADING_MODES.FULL, label: "全量模式", title: "启动时由 Babele 原生加载全部翻译文件。" },
    { mode: LOADING_MODES.ONDEMAND, label: "轻量模式", title: "启动只加载轻量索引，打开文档时按需加载完整翻译。" },
  ].map(({ mode, label, title }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.mode = mode;
    button.textContent = label;
    button.title = title;
    button.style.flex = "1 1 8rem";
    button.addEventListener("click", () => {
      select.value = mode;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      refreshLoadingModeButtons(buttonGroup, select.value);
    });
    buttonGroup.appendChild(button);
    return button;
  });

  const fields = select.closest?.(".form-fields") ?? select.parentElement;
  fields?.insertBefore?.(buttonGroup, select);
  refreshLoadingModeButtons(buttonGroup, select.value);
  logPatch("settings UI loading mode control enhanced", { value: select.value });

  if (!buttons.length) buttonGroup.remove();
}

function refreshLoadingModeButtons(buttonGroup, value) {
  for (const button of buttonGroup.querySelectorAll("button[data-mode]")) {
    const active = button.dataset.mode === value;
    button.classList.toggle("active", active);
    button.style.border = active ? "2px solid var(--color-border-highlight, #9f9275)" : "";
    button.style.fontWeight = active ? "700" : "";
  }
}

function isOnDemandMode() {
  return getLoadingModeSetting() === LOADING_MODES.ONDEMAND;
}

function tryPatchBabele(babele) {
  installFetchDiagnostics();
  tracePatch("tryPatchBabele entered", snapshotPatchState(babele));
  if (patched) {
    logPatch("tryPatchBabele skipped: already patched");
    return;
  }
  if (!babele) {
    logPatch("tryPatchBabele skipped: game.babele is not available");
    return;
  }

  const stateKey = "__ondemandPatch";
  if (babele[stateKey]?.patched) {
    logPatch("tryPatchBabele skipped: existing patch state found");
    patched = true;
    return;
  }

  const state = (babele[stateKey] = babele[stateKey] ?? {});
  state.patched = true;
  state.original = state.original ?? {};

  if (!state.original.init && typeof babele.init === "function") {
    state.original.init = babele.init.bind(babele);
  }
  if (!state.original.translateIndex && typeof babele.translateIndex === "function") {
    state.original.translateIndex = babele.translateIndex.bind(babele);
  }
  if (!state.original.translatePackFolders && typeof babele.translatePackFolders === "function") {
    state.original.translatePackFolders = babele.translatePackFolders.bind(babele);
  }
  if (!state.original.translateActor && typeof babele.translateActor === "function") {
    state.original.translateActor = babele.translateActor.bind(babele);
  }
  if (!state.original.translate && typeof babele.translate === "function") {
    state.original.translate = babele.translate.bind(babele);
  }
  if (!state.original.translateField && typeof babele.translateField === "function") {
    state.original.translateField = babele.translateField.bind(babele);
  }
  if (!state.original.extract && typeof babele.extract === "function") {
    state.original.extract = babele.extract.bind(babele);
  }
  if (!state.original.extractField && typeof babele.extractField === "function") {
    state.original.extractField = babele.extractField.bind(babele);
  }
  if (!state.original.isTranslated && typeof babele.isTranslated === "function") {
    state.original.isTranslated = babele.isTranslated.bind(babele);
  }
  if (!state.original.translatedCompendiumFor && typeof babele.translatedCompendiumFor === "function") {
    state.original.translatedCompendiumFor = babele.translatedCompendiumFor.bind(babele);
  }
  if (!state.original.mappedCompendiumFor && typeof babele.mappedCompendiumFor === "function") {
    state.original.mappedCompendiumFor = babele.mappedCompendiumFor.bind(babele);
  }
  if (!state.original.applyRuntimeTranslations && typeof babele.applyRuntimeTranslations === "function") {
    state.original.applyRuntimeTranslations = babele.applyRuntimeTranslations.bind(babele);
  }
  if (!state.original.registerConverters && typeof babele.registerConverters === "function") {
    state.original.registerConverters = babele.registerConverters.bind(babele);
  }
  if (!state.original.registerMapping && typeof babele.registerMapping === "function") {
    state.original.registerMapping = babele.registerMapping.bind(babele);
  }
  if (!state.original.register && typeof babele.register === "function") {
    state.original.register = babele.register.bind(babele);
  }
  if (!state.original.ensurePackTranslationsLoaded && typeof babele.ensurePackTranslationsLoaded === "function") {
    state.original.ensurePackTranslationsLoaded = babele.ensurePackTranslationsLoaded.bind(babele);
  }

  state.apiLevel = detectBabeleApiLevel(babele);
  logPatch("patching Babele facade", { apiLevel: state.apiLevel });
  state.registeredModules = state.registeredModules ?? [];
  state.packTranslationUrls = state.packTranslationUrls ?? new Map();
  state.packTranslationsLoading = state.packTranslationsLoading ?? new Map();
  state.globalMappingsLoaded = !!state.globalMappingsLoaded;
  state.labels = state.labels ?? null;
  state.titleIndex = state.titleIndex ?? null;
  state.translationFilesCache = state.translationFilesCache ?? null;
  state.mappingFilesCache = state.mappingFilesCache ?? null;
  state.packMissingConverters = state.packMissingConverters ?? new Map();
  state.npcDepsLoaded = !!state.npcDepsLoaded;
  state.npcDepsLoading = state.npcDepsLoading ?? null;
  state.actorImportHookRegistered = !!state.actorImportHookRegistered;
  state.actorNamePackLookup = state.actorNamePackLookup ?? null;
  state.actorNamePackLookupSource = state.actorNamePackLookupSource ?? null;
  state.compatPacks = state.compatPacks ?? new foundry.utils.Collection();
  state.loadedPacks = state.loadedPacks ?? new Map();
  state.lightMappedPacks = state.lightMappedPacks ?? new Map();
  state.documentIndexRebuildTimer = state.documentIndexRebuildTimer ?? null;
  state.lightRuntimeApplied = !!state.lightRuntimeApplied;
  state.initOnDemandPromise = state.initOnDemandPromise ?? null;
  state.readyRuntimeRefreshDone = !!state.readyRuntimeRefreshDone;

  tracePatch("patch state initialized", snapshotPatchState(babele, state));

  babele.isFullMode = () => !isOnDemandMode();
  babele.translateIndexTitles = (index, pack) => translateIndexTitles(state, index, pack);
  babele.applyLabels = (labels = null) => applyLabels(babele, labels ?? state.labels);
  babele.applyTitleIndex = (titleIndex = null) => {
    state.titleIndex = titleIndex ?? state.titleIndex ?? {};
    state.actorNamePackLookup = null;
    state.actorNamePackLookupSource = null;
  };

  babele.loadLabels = async () => {
    state.labels = await loadLabels(babele);
    return state.labels;
  };
  babele.loadTitleIndex = async () => {
    state.titleIndex = await loadTitleIndex(babele);
    return state.titleIndex;
  };

  babele.shareLabels = async () => {
    if (!game.user?.isGM) return;
    const labels = await babele.loadLabels();
    await game.settings.set(BABEL_NAMESPACE, SETTING_LABELS, labels);
  };
  babele.shareTitleIndex = async () => {
    if (!game.user?.isGM) return;
    const ti = await babele.loadTitleIndex();
    await game.settings.set(BABEL_NAMESPACE, SETTING_TITLE_INDEX, ti);
  };

  if (state.original.register) {
    babele.register = (module) => {
      recordTranslationModuleRegistration(state, module);
      return state.original.register(module);
    };
  }

  babele.registerConverters = (converters = {}) => {
    tracePatch("babele.registerConverters called", { names: Object.keys(converters ?? {}), mode: getLoadingModeSetting() });
    const result = state.original.registerConverters?.(converters);
    if (!isOnDemandMode()) return result;
    if (isModernBabele(state) && babele.initialized) {
      console.warn(
        `[${PATCH_ID}] registerConverters was called after initialization in modern Babele mode; reload the world to rebuild Babele runtime state.`,
      );
      return result;
    }
    const names = Object.keys(converters ?? {});
    if (!names.length) return result;
    void refreshPacksForConverters(babele, state, names);
    return result;
  };

  babele.registerMapping = (mapping) => {
    tracePatch("babele.registerMapping called", { types: Object.keys(mapping ?? {}), mode: getLoadingModeSetting() });
    const result = state.original.registerMapping?.(mapping);
    if (!isOnDemandMode()) return result;
    if (isModernBabele(state) && babele.initialized) {
      console.warn(
        `[${PATCH_ID}] registerMapping was called after initialization in modern Babele mode; reload the world to rebuild Babele runtime state.`,
      );
      return result;
    }
    if (mapping && typeof mapping === "object") {
      void refreshPacksForMapping(babele, state, mapping);
    }
    return result;
  };

  babele.ensurePackTranslationsLoaded = async (collection) => ensurePackTranslationsLoaded(babele, state, collection);
  babele.isTranslated = (pack) => {
    if (!isOnDemandMode()) return state.original.isTranslated?.(pack) ?? false;
    return !!getTranslatedPackCompat(babele, state, normalizePackId(pack));
  };
  babele.translatedCompendiumFor = (pack) => {
    if (!isOnDemandMode()) return state.original.translatedCompendiumFor?.(pack) ?? null;
    return getTranslatedPackCompat(babele, state, normalizePackId(pack));
  };
  babele.mappedCompendiumFor = (pack) => {
    if (!isOnDemandMode()) return state.original.mappedCompendiumFor?.(pack) ?? null;
    return getMappedPackCompat(babele, state, normalizePackId(pack));
  };
  babele.translate = (pack, data, translationsOnly = false) => {
    if (!isOnDemandMode()) return state.original.translate?.(pack, data, translationsOnly) ?? data;
    const translatedPack = getTranslatedPackCompat(babele, state, normalizePackId(pack));
    return translatedPack?.translate?.(data, translationsOnly) ?? data;
  };
  babele.translateField = (field, pack, data) => {
    if (!isOnDemandMode()) return state.original.translateField?.(field, pack, data) ?? null;
    return getMappedPackCompat(babele, state, normalizePackId(pack))?.translateField?.(field, data) ?? null;
  };
  babele.extract = (pack, data, options = {}) => {
    if (!isOnDemandMode()) return state.original.extract?.(pack, data, options);
    return getMappedPackCompat(babele, state, normalizePackId(pack))?.extract?.(data, options);
  };
  babele.extractField = (pack, field, data) => {
    if (!isOnDemandMode()) return state.original.extractField?.(pack, field, data);
    return getMappedPackCompat(babele, state, normalizePackId(pack))?.extractField?.(field, data);
  };
  babele.applyRuntimeTranslations = async (options = {}) => {
    if (!isOnDemandMode()) return state.original.applyRuntimeTranslations?.(options);
    await applyLightRuntimeTranslations(babele, state, options);
  };

  babele.translateActor = (actor) => {
    if (!actor) return state.original.translateActor?.(actor);
    const dialog = new PatchedOnDemandTranslateDialog(actor);
    dialog.render(true);
  };

  babele.init = async (callbackOrOptions = {}) => {
    tracePatch("babele.init entered", {
      mode: getLoadingModeSetting(),
      initialized: !!babele.initialized,
      hasCallback: typeof callbackOrOptions === "function",
      optionKeys: callbackOrOptions && typeof callbackOrOptions === "object" ? Object.keys(callbackOrOptions) : [],
    }, { stack: true });
    if (!isOnDemandMode()) {
      tracePatch("babele.init delegating to original init");
      return state.original.init?.(callbackOrOptions);
    }
    const afterInitialized =
      typeof callbackOrOptions === "function"
        ? callbackOrOptions
        : typeof callbackOrOptions?.afterInitialized === "function"
          ? callbackOrOptions.afterInitialized
          : null;
    if (babele.initialized) {
      tracePatch("babele.init short-circuit: already initialized");
      if (afterInitialized) await afterInitialized(babele);
      return true;
    }

    if (state.initOnDemandPromise) {
      tracePatch("babele.init joining in-flight initOnDemand");
      await state.initOnDemandPromise;
      if (afterInitialized) await afterInitialized(babele);
      tracePatch("babele.init after joined callback", snapshotPatchState(babele, state));
      return true;
    }

    tracePatch("babele.init starting initOnDemand");
    state.initOnDemandPromise = initOnDemand(babele, state);
    try {
      await state.initOnDemandPromise;
    } finally {
      state.initOnDemandPromise = null;
    }
    tracePatch("babele.init after initOnDemand", snapshotPatchState(babele, state));
    if (afterInitialized) await afterInitialized(babele);
    tracePatch("babele.init after callback", snapshotPatchState(babele, state));
    return true;
  };

  babele.translateIndex = (index, pack) => {
    tracePatch("babele.translateIndex called", { pack: normalizePackId(pack), count: Array.isArray(index) ? index.length : null });
    if (!isOnDemandMode()) {
      return state.original.translateIndex?.(index, pack) ?? index;
    }

    const packId = normalizePackId(pack);
    if (!packId) return index;

    const translatedPack = getTranslatedPackCompat(babele, state, packId);
    if (translatedPack?.translateIndex) {
      return translatedPack.translateIndex(index) ?? index;
    }
    return babele.translateIndexTitles(index, packId);
  };

  babele.translatePackFolders = (pack) => {
    tracePatch("babele.translatePackFolders called", { pack: normalizePackId(pack), folderCount: pack?.folders?.size ?? 0 });
    if (!isOnDemandMode()) {
      return state.original.translatePackFolders?.(pack);
    }

    if (!pack?.folders?.size) return;
    const packId = normalizePackId(pack);
    const folders = state.titleIndex?.[packId]?.folders ?? {};
    if (!folders || typeof folders !== "object") return;
    pack.folders.forEach((folder) => {
      const translated = folders[folder.originalName ?? folder.name];
      if (translated) {
        folder.originalName = folder.originalName ?? folder.name;
        folder.name = translated;
      }
    });
  };

  Hooks.on("babele.ready", async () => {
    tracePatch("babele.ready hook entered", snapshotPatchState(babele, state));
    if (!isOnDemandMode()) return;
    if (state.readyRuntimeRefreshDone) {
      tracePatch("babele.ready hook skipped: runtime refresh already done");
      return;
    }

    try {
      await babele.shareLabels?.();
      await babele.shareTitleIndex?.();
    } catch {
    }

    try {
      const labels = state.labels ?? (await babele.loadLabels?.());
      babele.applyLabels?.(labels);
    } catch {
    }

    try {
      if (!state.lightRuntimeApplied) {
        await applyLightRuntimeTranslations(babele, state, { shareSources: false, notify: false });
      } else {
        tracePatch("babele.ready hook skipped runtime refresh: already applied during init");
      }
    } catch {
    }
    state.readyRuntimeRefreshDone = true;
    tracePatch("babele.ready hook completed", snapshotPatchState(babele, state));
  });

  if (!state.actorImportHookRegistered && game.system?.id === "pf2e") {
    Hooks.on("preCreateActor", (actor, data, _options, userId) => {
      autoTranslateImportedActorInPreCreate(actor, data, userId);
    });
    Hooks.on("createActor", (actor, _options, userId) => {
      void autoTranslateImportedActorAfterCreate(actor, userId);
    });
    Hooks.on("preUpdateActor", (actor, change, options, userId) => {
      if (options?.[ACTOR_IMPORT_INTERNAL_OPTION]) return;
      autoTranslateImportedActorInPreUpdate(actor, change, userId);
    });
    Hooks.on("updateActor", (actor, _change, options, userId) => {
      if (options?.[ACTOR_IMPORT_INTERNAL_OPTION]) return;
      void autoTranslateImportedActorAfterUpdate(actor, userId);
    });
    state.actorImportHookRegistered = true;
    debugActorImport("已注册Actor导入翻译Hooks", {
      hooks: ["preCreateActor", "createActor", "preUpdateActor", "updateActor"],
    });
  }

  patched = true;
}

function getSourcePackId(itemData) {
  const sourceId = itemData?.flags?.core?.sourceId || itemData?._stats?.compendiumSource;
  const ref = sourceId ? foundry.utils.parseUuid(sourceId) : null;
  return ref?.collection ?? null;
}

function getActorSourcePackId(actorOrData) {
  const sourceId = actorOrData?.flags?.core?.sourceId || actorOrData?._stats?.compendiumSource;
  const ref = sourceId ? foundry.utils.parseUuid(sourceId) : null;
  return ref?.collection ?? null;
}

function shouldRunActorImportAutoTranslate(_babele) {
  if (game.system?.id !== "pf2e") return false;
  return true;
}

function registerDebugConsoleApi() {
  const root = globalThis;
  root.BabeleOnDemandPatchDebug = root.BabeleOnDemandPatchDebug ?? {};
  if (typeof root.BabeleOnDemandPatchDebug.actorImport !== "boolean") {
    root.BabeleOnDemandPatchDebug.actorImport = ACTOR_IMPORT_DEBUG_DEFAULT;
  }
  if (typeof root.BabeleOnDemandPatchDebug.trace !== "boolean") {
    root.BabeleOnDemandPatchDebug.trace = PATCH_TRACE_DEFAULT;
  }
  if (typeof root.BabeleOnDemandPatchDebug.fetchTrace !== "boolean") {
    root.BabeleOnDemandPatchDebug.fetchTrace = PATCH_FETCH_TRACE_DEFAULT;
  }

  game.babeleOnDemandPatch = game.babeleOnDemandPatch ?? {};
  game.babeleOnDemandPatch.getActorImportDebug = () => !!root.BabeleOnDemandPatchDebug.actorImport;
  game.babeleOnDemandPatch.setActorImportDebug = (enabled) => {
    root.BabeleOnDemandPatchDebug.actorImport = !!enabled;
    return root.BabeleOnDemandPatchDebug.actorImport;
  };
  game.babeleOnDemandPatch.getTraceDebug = () => !!root.BabeleOnDemandPatchDebug.trace;
  game.babeleOnDemandPatch.setTraceDebug = (enabled) => {
    root.BabeleOnDemandPatchDebug.trace = !!enabled;
    return root.BabeleOnDemandPatchDebug.trace;
  };
  game.babeleOnDemandPatch.getFetchTraceDebug = () => !!root.BabeleOnDemandPatchDebug.fetchTrace;
  game.babeleOnDemandPatch.setFetchTraceDebug = (enabled) => {
    root.BabeleOnDemandPatchDebug.fetchTrace = !!enabled;
    return root.BabeleOnDemandPatchDebug.fetchTrace;
  };
  game.babeleOnDemandPatch.dumpState = () => snapshotPatchState(game.babele, game.babele?.__ondemandPatch);
}

function debugActorImport(message, data = null) {
  if (!globalThis?.BabeleOnDemandPatchDebug?.actorImport) return;
  if (game.system?.id !== "pf2e") return;
  try {
    if (data !== null) console.info(`[${PATCH_ID}] [ActorImport] ${message}`, data);
    else console.info(`[${PATCH_ID}] [ActorImport] ${message}`);
  } catch {
  }
}

function normalizeActorNameForLookup(name) {
  if (typeof name !== "string") return null;
  const normalized = name.replace(/\s+/g, " ").trim().toLowerCase();
  return normalized.length ? normalized : null;
}

function collectActorNameLookupEntries(name) {
  const entries = new Map();
  const normalized = normalizeActorNameForLookup(name);
  if (!normalized) return [];

  const add = (key, score) => {
    if (typeof key !== "string" || !key.length) return;
    const prev = entries.get(key) ?? Number.NEGATIVE_INFINITY;
    if (score > prev) entries.set(key, score);
  };

  add(normalized, 120);

  const noParens = normalized.replace(/\s*[\(\（][^\)\）]*[\)\）]\s*$/g, "").trim();
  if (noParens && noParens !== normalized) add(noParens, 110);

  const latinTail = normalized.match(/[a-z][a-z0-9' -]*$/);
  if (latinTail?.[0]) add(latinTail[0].trim(), 100);

  const latinParts = normalized.match(/[a-z][a-z0-9' -]*/g) ?? [];
  for (const part of latinParts) {
    const key = part.trim();
    if (key) add(key, 70);
  }

  for (const part of normalized.split(/[\/｜|]/g)) {
    const key = normalizeActorNameForLookup(part);
    if (key) add(key, 60);
  }

  return Array.from(entries.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, score]) => ({ key, score }));
}

function getActorNamePackLookup(babele, state) {
  if (!state) return new Map();
  if (state.actorNamePackLookup && state.actorNamePackLookupSource === state.titleIndex) {
    return state.actorNamePackLookup;
  }

  const lookup = new Map();
  const index = state.titleIndex ?? {};

  for (const [packId, data] of Object.entries(index)) {
    const metadata = getPackMetadata(babele, packId);
    if (!metadata || metadata.type !== "Actor") continue;

    const titles = data?.titles;
    if (!titles || typeof titles !== "object") continue;

    const names = new Set([...Object.keys(titles), ...Object.values(titles)]);
    for (const name of names) {
      const entries = collectActorNameLookupEntries(name);
      for (const { key } of entries) {
        if (!lookup.has(key)) lookup.set(key, new Set());
        lookup.get(key).add(packId);
      }
    }
  }

  state.actorNamePackLookup = lookup;
  state.actorNamePackLookupSource = state.titleIndex;
  return lookup;
}

function resolveActorCandidatePackIds(babele, state, actorData) {
  const packScores = new Map();

  const sourcePackId = getActorSourcePackId(actorData);
  if (sourcePackId) {
    packScores.set(sourcePackId, 10_000);
  }

  const actorName = actorData?.name;
  const entries = collectActorNameLookupEntries(actorName);
  if (!entries.length) {
    return Array.from(packScores.keys());
  }

  const lookup = getActorNamePackLookup(babele, state);
  for (const { key, score } of entries) {
    const matched = lookup.get(key);
    if (!matched?.size) continue;
    for (const packId of matched) {
      const prev = packScores.get(packId) ?? Number.NEGATIVE_INFINITY;
      if (score > prev) packScores.set(packId, score);
    }
  }

  const sorted = Array.from(packScores.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([packId]) => packId);
  debugActorImport("候选包解析完成", {
    actorName: actorData?.name ?? null,
    sourceId: actorData?.flags?.core?.sourceId || actorData?._stats?.compendiumSource || null,
    candidates: sorted,
  });
  return sorted;
}

function packHasActorTranslation(pack, source) {
  if (!pack || typeof pack.hasTranslation !== "function") return true;
  try {
    return !!pack.hasTranslation(source);
  } catch {
    return true;
  }
}

function getActorSourceRef(actorData) {
  const sourceId = actorData?.flags?.core?.sourceId || actorData?._stats?.compendiumSource;
  if (!sourceId) return null;
  try {
    return foundry.utils.parseUuid(sourceId);
  } catch {
    return null;
  }
}

function mergeActorSourceWithChange(actor, change) {
  const base = typeof actor?.toObject === "function" ? actor.toObject() : {};
  try {
    return foundry.utils.mergeObject(base, change ?? {}, { inplace: false });
  } catch {
    return base;
  }
}

function getActorSourceDocumentId(actorData) {
  const ref = getActorSourceRef(actorData);
  return ref?.documentId ?? ref?.id ?? null;
}

function getActorSourceDocumentName(actorData) {
  const ref = getActorSourceRef(actorData);
  const packId = ref?.collection;
  const docId = ref?.documentId ?? ref?.id;
  if (!packId || !docId) return null;

  try {
    const pack = game.packs?.get?.(packId);
    const name = pack?.index?.get?.(docId)?.name;
    return typeof name === "string" && name.trim() ? name : null;
  } catch {
    return null;
  }
}

function buildActorTranslationProbes(source) {
  const probes = [];
  const seen = new Set();

  const pushProbe = (probe) => {
    if (!probe || typeof probe !== "object") return;
    const key = `${probe._id ?? ""}::${probe.name ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    probes.push(probe);
  };

  pushProbe(source);

  const sourceDocId = getActorSourceDocumentId(source);
  if (typeof sourceDocId === "string" && sourceDocId.length) {
    const byId =
      foundry.utils?.deepClone && typeof foundry.utils.deepClone === "function"
        ? foundry.utils.deepClone(source)
        : JSON.parse(JSON.stringify(source));
    byId._id = sourceDocId;
    pushProbe(byId);

    const sourceDocName = getActorSourceDocumentName(source);
    if (typeof sourceDocName === "string" && sourceDocName.length) {
      const byIdAndName =
        foundry.utils?.deepClone && typeof foundry.utils.deepClone === "function"
          ? foundry.utils.deepClone(byId)
          : JSON.parse(JSON.stringify(byId));
      byIdAndName.name = sourceDocName;
      pushProbe(byIdAndName);
    }
  }

  return probes;
}

function isMeaningfulActorTranslation(source, translated) {
  if (!translated || typeof translated !== "object") return false;
  if (translated?.flags?.babele?.translated || translated?.translated === true) return true;

  try {
    const diff = foundry.utils?.diffObject?.(source, translated);
    if (!diff || typeof diff !== "object") return false;
    const keys = Object.keys(diff).filter((k) => !["_id", "_stats", "sort"].includes(k));
    return keys.length > 0;
  } catch {
    return true;
  }
}

function tryTranslateActorFromPack(babele, packId, source) {
  const state = babele?.__ondemandPatch;
  const pack = getTranslatedPackCompat(babele, state, packId);
  const probes = buildActorTranslationProbes(source);
  if (!probes.length) return null;

  debugActorImport("开始尝试pack翻译", {
    packId,
    actorName: source?.name ?? null,
    probeCount: probes.length,
  });

  for (const probe of probes) {
    if (pack && !packHasActorTranslation(pack, probe)) continue;
    try {
      const translated = translateDataCompat(babele, state, packId, probe);
      if (!isMeaningfulActorTranslation(probe, translated)) continue;
      debugActorImport("pack翻译命中", {
        packId,
        probeId: probe?._id ?? null,
        probeName: probe?.name ?? null,
      });
      return translated;
    } catch {
    }
  }

  debugActorImport("pack翻译未命中", {
    packId,
    actorName: source?.name ?? null,
  });
  return null;
}

function autoTranslateImportedActorInPreCreate(actor, data, userId) {
  debugActorImport("preCreate enter", {
    actorName: actor?.name ?? data?.name ?? null,
    userId,
    mode: getLoadingModeSetting(),
  });
  if (!isOnDemandMode()) return;
  if (!actor || actor.pack) return;
  if (typeof userId === "string" && userId !== game.userId) return;

  const babele = game.babele;
  const state = babele?.__ondemandPatch;
  if (!babele || !state || !babele.initialized) return;
  if (!shouldRunActorImportAutoTranslate(babele)) return;

  const source = typeof actor?.toObject === "function" ? actor.toObject() : data;
  if (!source || source?.flags?.babele?.translated) return;

  debugActorImport("preCreate触发", {
    actorId: actor?.id ?? actor?._id ?? null,
    actorName: source?.name ?? null,
    sourceId: source?.flags?.core?.sourceId || source?._stats?.compendiumSource || null,
  });

  const candidates = resolveActorCandidatePackIds(babele, state, source);
  if (!candidates.length || typeof babele.translate !== "function") return;

  for (const packId of candidates) {
    if (!isPackTranslationLoadedCompat(babele, state, packId) && !babele.isTranslated?.(packId)) continue;
    const translated = tryTranslateActorFromPack(babele, packId, source);
    if (!translated) continue;
    actor.updateSource(translated);
    debugActorImport("preCreate应用翻译成功", {
      actorId: actor?.id ?? actor?._id ?? null,
      actorName: source?.name ?? null,
      packId,
    });
    return;
  }

  debugActorImport("preCreate未应用翻译", {
    actorId: actor?.id ?? actor?._id ?? null,
    actorName: source?.name ?? null,
  });
}

function autoTranslateImportedActorInPreUpdate(actor, change, userId) {
  debugActorImport("preUpdate enter", {
    actorName: actor?.name ?? change?.name ?? null,
    userId,
    mode: getLoadingModeSetting(),
  });
  if (!isOnDemandMode()) return;
  if (!actor || actor.pack) return;
  if (typeof userId === "string" && userId !== game.userId) return;

  const babele = game.babele;
  const state = babele?.__ondemandPatch;
  if (!babele || !state || !babele.initialized) return;
  if (!shouldRunActorImportAutoTranslate(babele)) return;

  const source = mergeActorSourceWithChange(actor, change);
  if (!source || source?.flags?.babele?.translated) return;
  if (!getActorSourcePackId(source)) return;

  debugActorImport("preUpdate触发", {
    actorId: actor?.id ?? actor?._id ?? null,
    actorName: source?.name ?? null,
    sourceId: source?.flags?.core?.sourceId || source?._stats?.compendiumSource || null,
  });

  const candidates = resolveActorCandidatePackIds(babele, state, source);
  if (!candidates.length || typeof babele.translate !== "function") return;

  for (const packId of candidates) {
    if (!isPackTranslationLoadedCompat(babele, state, packId) && !babele.isTranslated?.(packId)) continue;
    const translated = tryTranslateActorFromPack(babele, packId, source);
    if (!translated) continue;
    actor.updateSource(translated);
    debugActorImport("preUpdate应用翻译成功", {
      actorId: actor?.id ?? actor?._id ?? null,
      actorName: source?.name ?? null,
      packId,
    });
    return;
  }
}

async function autoTranslateImportedActorAfterCreate(actor, userId) {
  debugActorImport("afterCreate enter", {
    actorName: actor?.name ?? null,
    userId,
    mode: getLoadingModeSetting(),
  });
  if (!isOnDemandMode()) return;
  if (!actor || actor.pack) return;
  if (typeof userId === "string" && userId !== game.userId) return;

  const babele = game.babele;
  const state = babele?.__ondemandPatch;
  if (!babele || !state) return;
  if (!shouldRunActorImportAutoTranslate(babele)) return;

  const source = typeof actor?.toObject === "function" ? actor.toObject() : null;
  if (!source || source?.flags?.babele?.translated) return;

  debugActorImport("create后兜底触发", {
    actorId: actor?.id ?? actor?._id ?? null,
    actorName: source?.name ?? null,
    sourceId: source?.flags?.core?.sourceId || source?._stats?.compendiumSource || null,
  });

  try {
    if (!babele.initialized) {
      await babele.init();
    }
  } catch {
    return;
  }

  const candidates = resolveActorCandidatePackIds(babele, state, source);
  if (!candidates.length || typeof babele.translate !== "function") return;

  for (const packId of candidates) {
    try {
      await babele.ensurePackTranslationsLoaded?.(packId);
    } catch {
      debugActorImport("pack翻译加载失败", { packId, actorName: source?.name ?? null });
      continue;
    }
    if (!isPackTranslationLoadedCompat(babele, state, packId) && !babele.isTranslated?.(packId)) continue;

    const translated = tryTranslateActorFromPack(babele, packId, source);
    if (!translated) continue;
    await applyTranslatedActorToWorldActor(actor, translated);
    debugActorImport("create后兜底应用翻译成功", {
      actorId: actor?.id ?? actor?._id ?? null,
      actorName: source?.name ?? null,
      packId,
    });
    return;
  }

  debugActorImport("create后兜底未命中翻译", {
    actorId: actor?.id ?? actor?._id ?? null,
    actorName: source?.name ?? null,
  });
}

async function autoTranslateImportedActorAfterUpdate(actor, userId) {
  debugActorImport("afterUpdate enter", {
    actorName: actor?.name ?? null,
    userId,
    mode: getLoadingModeSetting(),
  });
  if (!isOnDemandMode()) return;
  if (!actor || actor.pack) return;
  if (typeof userId === "string" && userId !== game.userId) return;

  const babele = game.babele;
  const state = babele?.__ondemandPatch;
  if (!babele || !state) return;
  if (!shouldRunActorImportAutoTranslate(babele)) return;

  const source = typeof actor?.toObject === "function" ? actor.toObject() : null;
  if (!source || source?.flags?.babele?.translated) return;
  if (!getActorSourcePackId(source)) return;

  debugActorImport("update后兜底触发", {
    actorId: actor?.id ?? actor?._id ?? null,
    actorName: source?.name ?? null,
    sourceId: source?.flags?.core?.sourceId || source?._stats?.compendiumSource || null,
  });

  try {
    if (!babele.initialized) {
      await babele.init();
    }
  } catch {
    return;
  }

  const candidates = resolveActorCandidatePackIds(babele, state, source);
  if (!candidates.length || typeof babele.translate !== "function") return;

  for (const packId of candidates) {
    try {
      await babele.ensurePackTranslationsLoaded?.(packId);
    } catch {
      continue;
    }
    if (!isPackTranslationLoadedCompat(babele, state, packId) && !babele.isTranslated?.(packId)) continue;

    const translated = tryTranslateActorFromPack(babele, packId, source);
    if (!translated) continue;
    await applyTranslatedActorToWorldActor(actor, translated);
    debugActorImport("update后兜底应用翻译成功", {
      actorId: actor?.id ?? actor?._id ?? null,
      actorName: source?.name ?? null,
      packId,
    });
    return;
  }
}

async function applyTranslatedActorToWorldActor(actor, translated) {
  const payload =
    foundry.utils?.deepClone && typeof foundry.utils.deepClone === "function"
      ? foundry.utils.deepClone(translated)
      : JSON.parse(JSON.stringify(translated));
  if (!payload || typeof payload !== "object") return;

  delete payload._id;

  const items = Array.isArray(payload.items) ? payload.items : [];
  const effects = Array.isArray(payload.effects) ? payload.effects : [];
  delete payload.items;
  delete payload.effects;

  if (Object.keys(payload).length) {
    await actor.update(payload, { diff: false, [ACTOR_IMPORT_INTERNAL_OPTION]: true });
  }

  const itemUpdates = items.filter((item) => typeof item?._id === "string" && !!actor.items.get(item._id));
  if (itemUpdates.length) {
    await actor.updateEmbeddedDocuments("Item", itemUpdates, { [ACTOR_IMPORT_INTERNAL_OPTION]: true });
  }

  const effectUpdates = effects.filter((effect) => typeof effect?._id === "string" && !!actor.effects.get(effect._id));
  if (effectUpdates.length) {
    await actor.updateEmbeddedDocuments("ActiveEffect", effectUpdates, { [ACTOR_IMPORT_INTERNAL_OPTION]: true });
  }

  debugActorImport("已写回世界Actor翻译", {
    actorId: actor?.id ?? actor?._id ?? null,
    actorName: actor?.name ?? null,
    rootUpdated: Object.keys(payload).length,
    itemUpdates: itemUpdates.length,
    effectUpdates: effectUpdates.length,
  });
}

class PatchedOnDemandTranslateDialog extends Dialog {
  constructor(actor) {
    super(
      {
        title: game.i18n.localize("BABELE.TranslateActorTitle"),
        content:
          `<p>${game.i18n.localize("BABELE.TranslateActorHint")}</p>` +
          `<textarea rows="10" cols="50" id="actor-translate-log" style="font-family: Courier, monospace"></textarea>`,
        buttons: {
          translate: {
            icon: '<i class="fas fa-globe"></i>',
            label: game.i18n.localize("BABELE.TranslateActorBtn"),
            callback: async () => {
              const area = $("#actor-translate-log");
              area.append(`start...\n`);
              const items = actor.items.contents.length;
              let translated = 0;
              let untranslated = 0;

              const packIds = new Set();
              for (let idx = 0; idx < items; idx++) {
                const item = actor.items.contents[idx];
                const data = item?.toObject?.();
                const packId = getSourcePackId(data);
                if (packId) packIds.add(packId);
              }

              if (packIds.size && typeof game.babele?.ensurePackTranslationsLoaded === "function") {
                for (const packId of packIds) {
                  try {
                    await game.babele.ensurePackTranslationsLoaded(packId);
                  } catch {
                  }
                }
              }

              const updates = [];
              for (let idx = 0; idx < items; idx++) {
                const item = actor.items.contents[idx];
                const data = item.toObject();

                const sourcePackId = getSourcePackId(data);
                const babele = game.babele;
                const state = babele?.__ondemandPatch;
                let translatedData = null;

                if (sourcePackId) {
                  try {
                    await babele?.ensurePackTranslationsLoaded?.(sourcePackId);
                    if (isPackTranslationLoadedCompat(babele, state, sourcePackId) || babele?.isTranslated?.(sourcePackId)) {
                      translatedData = translateDataCompat(babele, state, sourcePackId, data, true);
                    }
                  } catch {
                  }
                }

                if (!translatedData && !isModernBabele(state)) {
                  const pack = findLegacyTranslatedPackForData(game.babele, data);
                  if (pack) translatedData = pack.translate(data, true);
                }

                if (translatedData) {
                  updates.push(foundry.utils.mergeObject(translatedData, { _id: item.id }));
                  area.append(`${data.name.padEnd(68, ".")}ok\n`);
                  translated++;
                } else {
                  area.append(`${data.name.padEnd(61, ".")}not found\n`);
                  untranslated++;
                }
              }

              if (updates.length) {
                area.append(`Updating...\n`);
                await actor.updateEmbeddedDocuments("Item", updates);
              }

              area.append(
                `\nDone. tot items: ${items}, tot translated: ${translated}, tot untranslated: ${untranslated}  \n                      \n`,
              );
            },
          },
        },
        default: "translate",
      },
      { width: 600 },
    );
  }

  submit(button) {
    try {
      button.callback();
    } catch (err) {
      ui.notifications.error(err);
      throw new Error(err);
    }
  }
}

async function initOnDemand(babele, state) {
  tracePatch("initOnDemand start", snapshotPatchState(babele, state));
  if (!isModernBabele(state)) {
    babele.packs = new foundry.utils.Collection();
    babele.translations = [];
  }
  babele.folders = game.data?.folders;

  tracePatch("initOnDemand loadGlobalMappingsOnce", snapshotPatchState(babele, state));
  await loadGlobalMappingsOnce(babele, state);

  const files = await getTranslationFiles(babele, state);
  tracePatch("initOnDemand translation files discovered", { count: files?.length ?? 0, sample: (files ?? []).slice(0, 10) });
  state.packTranslationUrls = buildPackTranslationUrlIndex(babele, files);
  tracePatch("initOnDemand packTranslationUrls indexed", { entries: state.packTranslationUrls.size });

  await ensureSpecialFolderTranslationsLoaded(babele, state, files);

  try {
    state.labels = await loadLabels(babele);
    tracePatch("initOnDemand labels loaded", { count: Object.keys(state.labels ?? {}).length });
    babele.applyLabels?.(state.labels);
  } catch {
    tracePatch("initOnDemand labels load failed");
  }

  try {
    state.titleIndex = await loadTitleIndex(babele);
    tracePatch("initOnDemand titleIndex loaded", { collections: Object.keys(state.titleIndex ?? {}).length });
  } catch {
    state.titleIndex = {};
    tracePatch("initOnDemand titleIndex load failed; reset to empty");
  }

  tracePatch("initOnDemand applyLightRuntimeTranslations begin");
  await applyLightRuntimeTranslations(babele, state, {
    shareSources: false,
    notify: false,
    rebuildDocumentIndexNow: true,
  });
  tracePatch("initOnDemand applyLightRuntimeTranslations end", snapshotPatchState(babele, state));

  babele.initialized = true;
  tracePatch("initOnDemand marked initialized", snapshotPatchState(babele, state));
  Hooks.callAll("babele.dataLoaded");
  tracePatch("initOnDemand emitted babele.dataLoaded");
}

async function applyLightRuntimeTranslations(
  babele,
  state,
  { shareSources = false, notify = false, rebuildDocumentIndexNow = false, rebuildPackTrees = false } = {},
) {
  if (!babele || !state) return;
  tracePatch("applyLightRuntimeTranslations start", {
    shareSources,
    notify,
    rebuildDocumentIndexNow,
    rebuildPackTrees,
    ...snapshotPatchState(babele, state),
  });

  if (shareSources && game.user?.isGM) {
    try {
      await game.settings.set(BABEL_NAMESPACE, SETTING_LABELS, state.labels ?? (await loadLabels(babele)));
    } catch {
    }
    try {
      await game.settings.set(BABEL_NAMESPACE, SETTING_TITLE_INDEX, state.titleIndex ?? (await loadTitleIndex(babele)));
    } catch {
    }
    try {
      const files = await getTranslationFiles(babele, state);
      await game.settings.set(BABEL_NAMESPACE, "translationFiles", files);
    } catch {
    }
    try {
      const mappingFiles = await getMappingFiles(babele, state);
      await game.settings.set(BABEL_NAMESPACE, "mappingFiles", mappingFiles);
    } catch {
    }
  }

  const labels = state.labels ?? {};
  applyLabels(babele, labels);
  tracePatch("applyLightRuntimeTranslations labels applied", { labelsCount: Object.keys(labels ?? {}).length });

  let packCount = 0;
  game.packs?.forEach?.((pack) => {
    try {
      packCount += 1;
      tracePatch("applyLightRuntimeTranslations pack begin", {
        packId: pack?.collection ?? pack?.metadata?.id ?? null,
        label: pack?.metadata?.label ?? null,
        indexCount: pack?.index?.size ?? pack?.index?.length ?? null,
        folderCount: pack?.folders?.size ?? 0,
      });
      restorePackIndexCompat(pack);
      restorePackFoldersCompat(pack);
      translateIndexTitles(state, pack.index, pack.collection);
      babele.translatePackFolders?.(pack);
      if (rebuildPackTrees) {
        tracePatch("applyLightRuntimeTranslations pack initializeTree", {
          packId: pack?.collection ?? pack?.metadata?.id ?? null,
        });
        pack.initializeTree?.();
      } else {
        tracePatch("applyLightRuntimeTranslations pack initializeTree skipped", {
          packId: pack?.collection ?? pack?.metadata?.id ?? null,
        });
      }
      tracePatch("applyLightRuntimeTranslations pack end", {
        packId: pack?.collection ?? pack?.metadata?.id ?? null,
        label: pack?.metadata?.label ?? null,
        indexCount: pack?.index?.size ?? pack?.index?.length ?? null,
      });
    } catch {
      tracePatch("applyLightRuntimeTranslations pack failed", {
        packId: pack?.collection ?? pack?.metadata?.id ?? null,
      });
    }
  });
  tracePatch("applyLightRuntimeTranslations packs processed", { packCount });

  state.lightRuntimeApplied = true;
  if (rebuildDocumentIndexNow) {
    tracePatch("applyLightRuntimeTranslations rebuildDocumentIndex immediately");
    await rebuildDocumentIndexCompat();
  } else {
    tracePatch("applyLightRuntimeTranslations schedule documentIndex rebuild");
    scheduleDocumentIndexRebuild(state, "light-runtime");
  }

  if (notify) {
    ui.notifications?.info?.("Babele on-demand light runtime refreshed.");
  }
  tracePatch("applyLightRuntimeTranslations end", snapshotPatchState(babele, state));
}

function restorePackIndexCompat(pack) {
  pack?.index?.forEach?.((entry) => {
    if (!entry) return;
    if (entry.originalName) {
      entry.name = entry.originalName;
    }
    if (entry.flags?.babele) {
      delete entry.flags.babele;
    }
    delete entry.originalName;
    delete entry.translated;
    delete entry.hasTranslation;
  });
}

function restorePackFoldersCompat(pack) {
  pack?.folders?.forEach?.((folder) => {
    if (!folder) return;
    if (folder.originalName) {
      folder.name = folder.originalName;
      delete folder.originalName;
    }
  });
}

function scheduleDocumentIndexRebuild(state, reason = "manual") {
  if (!state) return;
  if (state.documentIndexRebuildTimer) return;
  tracePatch("scheduleDocumentIndexRebuild queued", { reason });
  state.documentIndexRebuildTimer = globalThis.setTimeout(async () => {
    state.documentIndexRebuildTimer = null;
    try {
      tracePatch("scheduleDocumentIndexRebuild firing", { reason });
      await rebuildDocumentIndexCompat();
      logPatch("documentIndex rebuilt", { reason });
    } catch {
      tracePatch("scheduleDocumentIndexRebuild failed", { reason });
    }
  }, 50);
}

async function rebuildDocumentIndexCompat() {
  const documentIndex = game.documentIndex;
  if (!documentIndex || typeof documentIndex.index !== "function") {
    tracePatch("rebuildDocumentIndexCompat skipped: no index API");
    return;
  }
  tracePatch("rebuildDocumentIndexCompat start", {
    treeCount: Object.keys(documentIndex?.trees ?? {}).length,
    uuidCount: Object.keys(documentIndex?.uuids ?? {}).length,
  });
  await documentIndex.ready;
  for (const key of Object.keys(documentIndex?.trees ?? {})) {
    delete documentIndex.trees[key];
  }
  for (const key of Object.keys(documentIndex?.uuids ?? {})) {
    delete documentIndex.uuids[key];
  }
  await documentIndex.index();
  tracePatch("rebuildDocumentIndexCompat end", {
    treeCount: Object.keys(documentIndex?.trees ?? {}).length,
    uuidCount: Object.keys(documentIndex?.uuids ?? {}).length,
  });
}

function normalizePackId(pack) {
  if (!pack) return null;
  if (typeof pack === "string") return pack;
  if (typeof pack?.collection === "string") return pack.collection;
  if (typeof pack?.metadata?.id === "string") return pack.metadata.id;
  return null;
}

function isModernBabele(state) {
  return state?.apiLevel === "modern";
}

function recordTranslationModuleRegistration(state, module) {
  if (!state || !module || typeof module !== "object") return;
  const moduleId = module.module;
  if (typeof moduleId !== "string" || !moduleId.length) return;

  const dirs = normalizeTranslationModuleDirs(module);
  if (!dirs.length) return;

  const registration = {
    module: moduleId,
    dirs,
    lang: typeof module.lang === "string" && module.lang.length ? module.lang : null,
  };
  const key = JSON.stringify(registration);
  if (state.registeredModules.some((m) => JSON.stringify(m) === key)) return;
  state.registeredModules.push(registration);
}

function normalizeTranslationModuleDirs(module) {
  const rawDirs = Array.isArray(module?.dirs) ? module.dirs : [module?.dir];
  return rawDirs.filter((dir) => typeof dir === "string" && dir.trim()).map((dir) => dir.trim());
}

function getRegisteredTranslationModules(babele, state) {
  const modules = [];
  const push = (module) => {
    if (!module || typeof module !== "object") return;
    const moduleId = module.module;
    if (typeof moduleId !== "string" || !moduleId.length) return;
    const dirs = normalizeTranslationModuleDirs(module);
    if (!dirs.length) return;
    modules.push({
      module: moduleId,
      dirs,
      lang: typeof module.lang === "string" && module.lang.length ? module.lang : null,
    });
  };

  for (const module of babele?.modules ?? []) push(module);
  for (const module of state?.registeredModules ?? []) push(module);

  const seen = new Set();
  return modules.filter((module) => {
    const key = JSON.stringify(module);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collectionFromMetadata(babele, metadata) {
  if (!metadata) return null;
  if (typeof metadata.collection === "string") return metadata.collection;
  if (typeof metadata.id === "string") return metadata.id;

  if (typeof babele?.getCollection === "function") {
    try {
      const collection = babele.getCollection(metadata);
      if (typeof collection === "string" && collection.length) return collection;
    } catch {
    }
  }

  if (typeof metadata.packageName === "string" && typeof metadata.name === "string") {
    const collectionPrefix = metadata.packageType === "world" ? "world" : metadata.packageName;
    return `${collectionPrefix}.${metadata.name}`;
  }

  return null;
}

function metadataSupportedByBabele(babele, metadata) {
  if (!metadata) return false;

  if (typeof babele?.supported === "function") {
    try {
      return !!babele.supported(metadata);
    } catch {
    }
  }

  if (typeof babele?.documentMappings?.supports === "function") {
    return !!babele.documentMappings.supports(metadata.type);
  }

  return !!babele?.constructor?.DEFAULT_MAPPINGS?.[metadata.type];
}

function getTranslatedPackCompat(babele, state, packId) {
  if (!babele || !packId) return null;
  if (isModernBabele(state)) {
    return state?.loadedPacks?.get?.(packId) ?? state?.compatPacks?.get?.(packId) ?? null;
  }
  return babele.packs?.get?.(packId) ?? state?.compatPacks?.get?.(packId) ?? null;
}

function findLegacyTranslatedPackForData(babele, data) {
  return babele?.packs?.find?.((p) => p.translated && p.hasTranslation(data)) ?? null;
}

function isPackTranslationLoadedCompat(babele, state, packId) {
  if (!babele || !packId) return false;
  if (isModernBabele(state)) {
    return !!state?.loadedPacks?.get?.(packId) || !!state?.compatPacks?.get?.(packId)?.translated;
  }
  return !!babele.packs?.get?.(packId)?.translated || !!state?.compatPacks?.get?.(packId)?.translated;
}

function translateDataCompat(babele, state, packId, data, translationsOnly = false) {
  if (!babele) return data;
  const translatedPack = getTranslatedPackCompat(babele, state, packId);
  if (translatedPack?.translate) {
    const translated = translatedPack.translate(data, translationsOnly);
    if (translated !== undefined) {
      return translated;
    }
  }
  if (!isModernBabele(state) && typeof babele.translate === "function") {
    let translated = babele.translate(packId, data, translationsOnly);
    if (state?.compatPacks?.get?.(packId)?.translated && !isMeaningfulActorTranslation(data, translated)) {
      translated = state.compatPacks.get(packId).translate(data, translationsOnly);
    }
    return translated;
  }
  return data;
}

function getMappedPackCompat(babele, state, packId) {
  if (!babele || !packId) return null;
  const loaded = getTranslatedPackCompat(babele, state, packId);
  if (loaded) return loaded;
  if (!isModernBabele(state)) return babele.packs?.get?.(packId) ?? null;

  if (!state.lightMappedPacks?.has?.(packId)) {
    const metadata = getPackMetadata(babele, packId);
    if (!metadata) return null;
    state.lightMappedPacks.set(packId, createLightMappedPackCompat(babele, state, metadata, packId));
  }
  return state.lightMappedPacks.get(packId) ?? null;
}

function createLightMappedPackCompat(babele, state, metadata, packId) {
  const translatedIndex = (index) => translateIndexTitles(state, index, packId);
  return {
    metadata,
    translated: false,
    hasTranslation(data) {
      const titles = state.titleIndex?.[packId]?.titles ?? {};
      const candidates = [
        data?._id,
        data?.originalName,
        data?.name,
        data?.flags?.core?.sourceId,
      ].filter((value) => typeof value === "string" && value.length);
      return candidates.some((value) => Object.prototype.hasOwnProperty.call(titles, value));
    },
    translateIndex(index) {
      return translatedIndex(index);
    },
    translate(data) {
      return data;
    },
    translateField() {
      return null;
    },
    extract(data) {
      return data;
    },
    extractField() {
      return null;
    },
  };
}

function getTranslationDirectories(babele, state = babele?.__ondemandPatch) {
  const lang = game.settings.get("core", "language");
  const directory = game.settings.get(BABEL_NAMESPACE, "directory");
  const system = babele.systemTranslationsDir
    ? [`systems/${game.system.id}/${babele.systemTranslationsDir}/${lang}`]
    : [];
  const modules = getRegisteredTranslationModules(babele, state)
    .filter((m) => !m.lang || m.lang === lang)
    .flatMap((m) => m.dirs.map((dir) => `modules/${m.module}/${dir}`));
  const configured = directory && directory.trim && directory.trim() ? [`${directory}/${lang}`] : [];
  return orderTranslationSources({ system, modules, configured });
}

function getMappingDirectories(babele, state = babele?.__ondemandPatch) {
  const directory = game.settings.get(BABEL_NAMESPACE, "directory");
  const system = babele.systemTranslationsDir ? [`systems/${game.system.id}/${babele.systemTranslationsDir}`] : [];
  const modules = getRegisteredTranslationModules(babele, state).flatMap((m) =>
    m.dirs.map((dir) => `modules/${m.module}/${dir}`),
  );
  const configured = directory && directory.trim && directory.trim() ? [directory] : [];
  return orderTranslationSources({ system, modules, configured });
}

async function getTranslationFiles(babele, state) {
  if (state.translationFilesCache) {
    tracePatch("getTranslationFiles cache hit", { count: state.translationFilesCache.length });
    return state.translationFilesCache;
  }

  if (!game.user?.hasPermission?.("FILES_BROWSE")) {
    const files = game.settings.get(BABEL_NAMESPACE, "translationFiles") ?? [];
    tracePatch("getTranslationFiles using shared settings fallback", { count: files.length, sample: files.slice(0, 10) });
    return files;
  }

  const dirs = getTranslationDirectories(babele, state);
  tracePatch("getTranslationFiles browsing dirs", { dirs });
  const files = [];
  for (const dir of dirs) {
    try {
      const result = await foundry.applications.apps.FilePicker.browse("data", dir);
      tracePatch("getTranslationFiles browse result", { dir, count: result.files?.length ?? 0 });
      for (const f of result.files ?? []) files.push(f);
    } catch {
      tracePatch("getTranslationFiles browse failed", { dir });
    }
  }
  state.translationFilesCache = files;
  tracePatch("getTranslationFiles completed", { count: files.length, sample: files.slice(0, 20) });
  return files;
}

async function getMappingFiles(babele, state) {
  if (state.mappingFilesCache) {
    tracePatch("getMappingFiles cache hit", { count: state.mappingFilesCache.length });
    return state.mappingFilesCache;
  }

  if (!game.user?.hasPermission?.("FILES_BROWSE")) {
    const files = game.settings.get(BABEL_NAMESPACE, "mappingFiles") ?? [];
    tracePatch("getMappingFiles using shared settings fallback", { count: files.length, sample: files.slice(0, 10) });
    return files;
  }

  const dirs = getMappingDirectories(babele, state);
  tracePatch("getMappingFiles browsing dirs", { dirs });
  const files = [];
  for (const dir of dirs) {
    try {
      const result = await foundry.applications.apps.FilePicker.browse("data", dir);
      tracePatch("getMappingFiles browse result", { dir, count: result.files?.length ?? 0 });
      for (const f of result.files ?? []) {
        if (typeof f === "string" && isMappingFileName(f)) files.push(f);
      }
    } catch {
      tracePatch("getMappingFiles browse failed", { dir });
    }
  }
  state.mappingFilesCache = sortMappingFilesByDirectoryPreference(files);
  tracePatch("getMappingFiles completed", { count: state.mappingFilesCache.length, files: state.mappingFilesCache.slice(0, 20) });
  return state.mappingFilesCache;
}

async function loadGlobalMappingsOnce(babele, state) {
  if (state.globalMappingsLoaded) {
    tracePatch("loadGlobalMappingsOnce skipped: already loaded");
    return;
  }
  const mappingFiles = await getMappingFiles(babele, state);
  tracePatch("loadGlobalMappingsOnce mapping files", { count: mappingFiles?.length ?? 0, files: mappingFiles ?? [] });
  if (mappingFiles?.length) {
    const mappings = await Promise.all(
      mappingFiles.map(async (file) => {
        try {
          const r = await fetch(file);
          return await r.json();
        } catch {
          return null;
        }
      }),
    );
    mappings.filter(Boolean).forEach((m) => babele.registerMapping?.(m));
    tracePatch("loadGlobalMappingsOnce mappings registered", { count: mappings.filter(Boolean).length });
  }
  state.globalMappingsLoaded = true;
  tracePatch("loadGlobalMappingsOnce completed");
}

function buildPackTranslationUrlIndex(babele, files) {
  const index = new Map();
  for (const metadata of game.data?.packs ?? []) {
    if (!metadataSupportedByBabele(babele, metadata)) continue;
    const collection = collectionFromMetadata(babele, metadata);
    if (!collection) continue;
    const encodedCollection = encodeURI(collection);
    const exactFileName = `${encodedCollection}.json`;
    const urls = (files ?? []).filter((f) => {
      const baseName = f?.split?.("/").pop?.().split?.("\\").pop?.();
      if (baseName === exactFileName) return true;
      if (typeof baseName !== "string") return false;
      return baseName.startsWith(`${encodedCollection}.`) && baseName.endsWith(".json");
    });
    if (urls.length) index.set(collection, urls);
  }
  return index;
}

function buildDirectPackTranslationUrls(babele, packId, state = babele?.__ondemandPatch) {
  const fileName = `${encodeURI(packId)}.json`;
  return getTranslationDirectories(babele, state).map((dir) => {
    const base = dir.endsWith("/") ? dir.slice(0, -1) : dir;
    return `${base}/${fileName}`;
  });
}

async function importLegacyTranslatedCompendium() {
  try {
    const module = await import("/modules/babele/script/translated-compendium.js");
    return module.TranslatedCompendium ?? null;
  } catch {
    return null;
  }
}

async function importModernMappedCompendium() {
  try {
    const module = await import("/modules/babele/script/compendium/mapped-compendium.js");
    return module.MappedCompendium ?? null;
  } catch {
    return null;
  }
}

async function createModernMappedPackCompat(babele, metadata, translation) {
  if (!babele?.documentMappings || !metadataSupportedByBabele(babele, metadata)) return null;

  const MappedCompendium = await importModernMappedCompendium();
  if (!MappedCompendium) return null;

  return new MappedCompendium(metadata, translation, {
    translationStrategies: babele.translationMatchStrategies?.() ?? [],
    documentMappings: babele.documentMappings,
  });
}

function publishTranslatedPackCompat(babele, state, packId, translatedPack) {
  if (!translatedPack || !packId) return;
  state.compatPacks.set(packId, translatedPack);

  if (isModernBabele(state)) {
    state.loadedPacks.set(packId, translatedPack);
    state.lightMappedPacks.delete(packId);
    return;
  }

  babele.packs?.set?.(packId, translatedPack);
}

async function createTranslatedPackCompat(babele, state, metadata, translation) {
  if (!metadata || !translation) return null;

  if (isModernBabele(state)) {
    const mappedPack = await createModernMappedPackCompat(babele, metadata, translation);
    if (mappedPack) return mappedPack;

    const collection = getPackMetadataCollection(babele, metadata);
    console.warn(`[${PATCH_ID}] Unable to create a Babele 2.9 mapped compendium adapter for ${collection}.`);
    return null;
  }

  const LegacyTranslatedCompendium = await importLegacyTranslatedCompendium();
  if (LegacyTranslatedCompendium) {
    return new LegacyTranslatedCompendium(metadata, translation);
  }

  return null;
}

function getPackMetadataCollection(babele, metadata) {
  return collectionFromMetadata(babele, metadata) ?? `${metadata?.packageName ?? "unknown"}.${metadata?.name ?? "unknown"}`;
}

async function ensureSpecialFolderTranslationsLoaded(babele, state, files) {
  if (!babele.folders) return;
  const suffix = babele.constructor?.PACK_FOLDER_TRANSLATION_NAME_SUFFIX ?? "_packs-folders";
  const folderFiles = (files ?? []).filter((f) => typeof f === "string" && f.endsWith(`${suffix}.json`));
  if (!folderFiles.length) return;

  for (const file of folderFiles) {
    const baseName = file.split("/").pop().split("\\").pop();
    const [packageName, name] = baseName.split(".");
    const collection = `${packageName}.${name}`;
    if (isPackTranslationLoadedCompat(babele, state, collection)) continue;

    const translation = await loadTranslationFromUrls([file]);
    if (!translation) continue;

    const metadata = { packageType: "system", type: "Folder", packageName, name };
    const translatedPack = await createTranslatedPackCompat(babele, state, metadata, translation);
    if (translatedPack) {
      publishTranslatedPackCompat(babele, state, collection, translatedPack);
    }
  }
}

async function loadLabels(babele) {
  const fromSettings = game.settings.get(BABEL_NAMESPACE, SETTING_LABELS) ?? {};
  const result = { ...(typeof fromSettings === "object" && !Array.isArray(fromSettings) ? fromSettings : {}) };
  tracePatch("loadLabels start", { fromSettingsCount: Object.keys(result).length });

  const tryFetch = game.user?.hasPermission?.("FILES_BROWSE") || Object.keys(result).length === 0;
  if (!tryFetch) {
    tracePatch("loadLabels skipped fetch; using settings cache", { count: Object.keys(result).length });
    return result;
  }

  const dirs = getTranslationDirectories(babele);
  tracePatch("loadLabels fetch dirs", { dirs });
  for (const dir of dirs) {
    const base = dir.endsWith("/") ? dir.slice(0, -1) : dir;
    const url = `${base}/labels.json`;
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const json = await r.json();
      if (json && typeof json === "object") Object.assign(result, json);
    } catch {
      tracePatch("loadLabels fetch failed", { url });
    }
  }
  tracePatch("loadLabels end", { count: Object.keys(result).length });
  return result;
}

async function loadTitleIndex(babele) {
  const fromSettings = game.settings.get(BABEL_NAMESPACE, SETTING_TITLE_INDEX) ?? {};
  const index =
    typeof fromSettings === "object" && !Array.isArray(fromSettings)
      ? (foundry.utils?.deepClone ? foundry.utils.deepClone(fromSettings) : JSON.parse(JSON.stringify(fromSettings)))
      : {};
  tracePatch("loadTitleIndex start", { fromSettingsCollections: Object.keys(index).length });

  const tryFetch = game.user?.hasPermission?.("FILES_BROWSE") || Object.keys(index).length === 0;
  if (!tryFetch) {
    tracePatch("loadTitleIndex skipped fetch; using settings cache", { collections: Object.keys(index).length });
    return index;
  }

  const dirs = getTranslationDirectories(babele);
  tracePatch("loadTitleIndex fetch dirs", { dirs });
  for (const dir of dirs) {
    const base = dir.endsWith("/") ? dir.slice(0, -1) : dir;
    const url = `${base}/titles.json`;
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const json = await r.json();
      if (!json || typeof json !== "object" || Array.isArray(json)) continue;
      for (const [collection, data] of Object.entries(json)) {
        if (!data || typeof data !== "object") continue;
        if (!index[collection]) index[collection] = { titles: {}, folders: {} };
        if (data.titles && typeof data.titles === "object") Object.assign(index[collection].titles, data.titles);
        if (data.folders && typeof data.folders === "object") Object.assign(index[collection].folders, data.folders);
      }
    } catch {
      tracePatch("loadTitleIndex fetch failed", { url });
    }
  }
  tracePatch("loadTitleIndex end", { collections: Object.keys(index).length });
  return index;
}

function applyLabels(babele, labels) {
  if (!labels || typeof labels !== "object") return;

  try {
    for (const metadata of game.data?.packs ?? []) {
      const collection = collectionFromMetadata(babele, metadata);
      if (labels[collection]) {
        metadata.originalLabel = metadata.originalLabel ?? metadata.label;
        metadata.label = labels[collection];
      }
    }
  } catch {
  }

  try {
    game.packs?.forEach?.((pack) => {
      if (labels[pack.collection]) {
        pack.metadata.originalLabel = pack.metadata.originalLabel ?? pack.metadata.label;
        pack.metadata.label = labels[pack.collection];
      }
    });
  } catch {
  }
}

function translateIndexTitles(state, index, packId) {
  const titles = state.titleIndex?.[packId]?.titles;
  if (!titles || !index) return index;

  const applyEntry = (entry, keyFromIndex = null) => {
    if (!entry) return;
    if (entry.translated || entry?.flags?.babele?.translated) return;

    const keyCandidates = [keyFromIndex, entry._id, entry.originalName, entry.name].filter(
      (v) => typeof v === "string" && v.length,
    );
    let translatedName = null;
    for (const k of keyCandidates) {
      translatedName = titles[k];
      if (typeof translatedName === "string" && translatedName.length) break;
    }
    if (typeof translatedName !== "string" || !translatedName.length) return;

    entry.originalName = entry.originalName ?? entry.name;
    entry.name = translatedName;
    entry.translated = true;
    entry.hasTranslation = true;
    entry.flags = foundry.utils.mergeObject(entry.flags ?? {}, {
      babele: {
        translated: true,
        hasTranslation: true,
        originalName: entry.originalName,
      },
    });
  };

  for (const raw of index) {
    if (Array.isArray(raw)) applyEntry(raw[1], raw[0]);
    else applyEntry(raw);
  }
  return index;
}

function reconstructDocumentCompat(documentClass, source, packId) {
  if (typeof documentClass?.fromSource === "function") {
    return documentClass.fromSource(source, { pack: packId });
  }
  return new documentClass(source, { pack: packId });
}

function mappingUsesConverters(mapping, targetConverters) {
  if (!mapping || typeof mapping !== "object") return false;
  for (const value of Object.values(mapping)) {
    if (!value || typeof value !== "object") continue;
    const converter = value.converter;
    if (typeof converter === "string" && targetConverters.has(converter)) return true;
    if (mappingUsesConverters(value, targetConverters)) return true;
  }
  return false;
}

async function ensureNpcDependenciesLoaded(babele, state, currentPackId) {
  if (!state || state.npcDepsLoaded) return;
  if (state.npcDepsLoading) {
    await state.npcDepsLoading;
    return;
  }

  const loader = (async () => {
    for (const packId of NPC_TRANSLATOR_DEP_PACKS) {
      if (packId === currentPackId) continue;
      try {
        await ensurePackTranslationsLoaded(babele, state, packId);
      } catch {
      }
    }
    state.npcDepsLoaded = true;
  })();

  state.npcDepsLoading = loader;
  try {
    await loader;
  } finally {
    state.npcDepsLoading = null;
  }
}

async function ensurePackTranslationsLoaded(babele, state, collection) {
  const packId = normalizePackId(collection);
  if (!packId) return;
  tracePatch("ensurePackTranslationsLoaded enter", {
    packId,
    alreadyLoaded: isPackTranslationLoadedCompat(babele, state, packId),
    pending: state.packTranslationsLoading.get(packId) != null,
    indexedUrlCount: state.packTranslationUrls?.get?.(packId)?.length ?? 0,
  }, { stack: true });

  if (isPackTranslationLoadedCompat(babele, state, packId)) return;

  const pending = state.packTranslationsLoading.get(packId);
  if (pending) {
    await pending;
    return;
  }

  const loader = (async () => {
    if (!state.packTranslationUrls?.size) {
      const files = await getTranslationFiles(babele, state);
      state.packTranslationUrls = buildPackTranslationUrlIndex(babele, files);
      tracePatch("ensurePackTranslationsLoaded rebuilt URL index", { entries: state.packTranslationUrls.size });
    }

    let urls = state.packTranslationUrls.get(packId);
    debugActorImport("尝试加载pack翻译", {
      packId,
      hasIndexedUrls: !!urls?.length,
      indexedUrlCount: urls?.length ?? 0,
    });
    let translation = urls?.length ? await loadTranslationFromUrls(urls) : null;
    tracePatch("ensurePackTranslationsLoaded indexed URL load result", {
      packId,
      urlCount: urls?.length ?? 0,
      loaded: !!translation,
      hasReference: !!translation?.reference,
    });

    if (!translation) {
      const directUrls = buildDirectPackTranslationUrls(babele, packId, state);
      const directTranslation = await loadTranslationFromUrls(directUrls);
      if (directTranslation) {
        urls = directUrls;
        translation = directTranslation;
        state.packTranslationUrls.set(packId, urls);
        debugActorImport("pack翻译通过目录直探加载成功", {
          packId,
          urls,
        });
      }
      tracePatch("ensurePackTranslationsLoaded direct URL load result", {
        packId,
        urlCount: directUrls.length,
        loaded: !!directTranslation,
      });
    }

    if (!translation) {
      debugActorImport("pack翻译加载失败（未找到可用json）", { packId });
      tracePatch("ensurePackTranslationsLoaded abort: no translation found", { packId });
      return;
    }

    const metadata = getPackMetadata(babele, packId);
    if (!metadata) {
      tracePatch("ensurePackTranslationsLoaded abort: no metadata", { packId });
      return;
    }
    tracePatch("ensurePackTranslationsLoaded metadata resolved", {
      packId,
      type: metadata.type,
      packageName: metadata.packageName ?? null,
      name: metadata.name ?? null,
    });

    if (!state.npcDepsLoaded && !state.npcDepsLoading) {
      const needsNpcDeps = mappingUsesConverters(translation.mapping, NPC_TRANSLATOR_CONVERTERS);
      if (needsNpcDeps) {
        await ensureNpcDependenciesLoaded(babele, state, packId);
      }
    }

    trackMissingConverters(babele, state, packId, metadata, translation);

    const storedTranslation = foundry.utils.mergeObject(translation, { collection: packId });
    const translatedPack = await createTranslatedPackCompat(babele, state, metadata, translation);
    if (translatedPack) {
      publishTranslatedPackCompat(babele, state, packId, translatedPack);
      tracePatch("ensurePackTranslationsLoaded translated pack published", {
        packId,
        translated: !!translatedPack?.translated,
        referenceCount: Array.isArray(translation.reference)
          ? translation.reference.length
          : translation.reference ? 1 : 0,
      });
    } else if (isModernBabele(state)) {
      state.lightMappedPacks.set(packId, createLightMappedPackCompat(babele, state, metadata, packId));
      tracePatch("ensurePackTranslationsLoaded fallback to lightMappedPack", { packId });
    }

    if (!isModernBabele(state) && Array.isArray(babele.translations)) {
      const idx = babele.translations.findIndex((t) => t?.collection === packId);
      if (idx >= 0) {
        babele.translations[idx] = storedTranslation;
      } else {
        babele.translations.push(storedTranslation);
      }
    } else if (!isModernBabele(state)) {
      babele.translations = [storedTranslation];
    }

    if (!isModernBabele(state) && metadata.type === "Adventure" && translation.entries) {
      const entries = translation.entries;
      for (const adventure of Object.values(Array.isArray(entries) ? entries : entries || {})) {
        const embeddedTranslation = {
          mapping: translation.mapping ? translation.mapping["items"] ?? {} : {},
          entries: adventure.items ?? {},
        };
        const embeddedPack = await createTranslatedPackCompat(babele, state, { type: "Item" }, embeddedTranslation);
        if (embeddedPack) {
          publishTranslatedPackCompat(babele, state, `${packId}-items`, embeddedPack);
        }
      }
    }

    if (translation.reference) {
      const refs = Array.isArray(translation.reference) ? translation.reference : [translation.reference];
      tracePatch("ensurePackTranslationsLoaded loading references", { packId, refs });
      for (const ref of refs) {
        await ensurePackTranslationsLoaded(babele, state, ref);
      }
    }
    tracePatch("ensurePackTranslationsLoaded exit success", {
      packId,
      loadedPacks: state.loadedPacks?.size ?? 0,
      lightMappedPacks: state.lightMappedPacks?.size ?? 0,
    });
  })();

  state.packTranslationsLoading.set(packId, loader);
  try {
    await loader;
  } finally {
    state.packTranslationsLoading.delete(packId);
  }
}

async function loadTranslationFromUrls(urls) {
  tracePatch("loadTranslationFromUrls start", { urls });
  const translations = await Promise.all(
    (urls ?? []).map(async (url) => {
      try {
        const r = await fetch(url);
        const json = await r.json();
        tracePatch("loadTranslationFromUrls fetched JSON", {
          url,
          ok: r?.ok ?? null,
          status: r?.status ?? null,
          hasEntries: !!json?.entries,
          hasMapping: !!json?.mapping,
          hasReference: !!json?.reference,
        });
        return json;
      } catch {
        tracePatch("loadTranslationFromUrls fetch failed", { url });
        return null;
      }
    }),
  );

  const merged = mergeTranslationPayloads(translations);
  tracePatch("loadTranslationFromUrls end", {
    urlCount: urls?.length ?? 0,
    loadedCount: translations.filter(Boolean).length,
    merged: !!merged,
    hasReference: !!merged?.reference,
  });
  return merged;
}

function getMergedMapping(babele, metadata, translation) {
  if (babele?.documentMappings && metadata?.type) {
    const base = babele.documentMappings.hierarchyFor?.(metadata.type)?.mappingFor?.({ type: metadata.type })?.definition ?? {};
    const extra = translation?.mapping ?? {};
    return foundry.utils.mergeObject(base, extra, { inplace: false });
  }
  const base = babele.constructor?.DEFAULT_MAPPINGS?.[metadata?.type] ?? {};
  const extra = translation?.mapping ?? {};
  return foundry.utils.mergeObject(base, extra, { inplace: false });
}

function collectMissingConverters(babele, mapping) {
  const missing = new Set();
  if (!mapping || typeof mapping !== "object") return missing;
  for (const value of Object.values(mapping)) {
    if (!value || typeof value !== "object") continue;
    const converter = value.converter;
    if (typeof converter !== "string" || !converter.length) continue;
    if (!babele?.converters?.[converter]) missing.add(converter);
  }
  return missing;
}

function trackMissingConverters(babele, state, packId, metadata, translation) {
  if (isModernBabele(state)) return;
  try {
    const merged = getMergedMapping(babele, metadata, translation);
    const missing = collectMissingConverters(babele, merged);
    if (missing.size) state.packMissingConverters.set(packId, missing);
    else state.packMissingConverters.delete(packId);
  } catch {
  }
}

function getPackMetadata(babele, packId) {
  return (game.data?.packs ?? []).find((m) => collectionFromMetadata(babele, m) === packId);
}

async function rebuildTranslatedPack(babele, state, packId, translation) {
  const metadata = getPackMetadata(babele, packId);
  if (!metadata) return false;
  if (isModernBabele(state)) return false;

  const translatedPack = await createTranslatedPackCompat(babele, state, metadata, translation);
  if (!translatedPack) return false;
  publishTranslatedPackCompat(babele, state, packId, translatedPack);

  if (metadata.type === "Adventure" && translation.entries) {
    const entries = translation.entries;
    for (const adventure of Object.values(Array.isArray(entries) ? entries : entries || {})) {
      const embeddedPack = await createTranslatedPackCompat(
        babele,
        state,
        { type: "Item" },
        {
          mapping: translation.mapping ? translation.mapping["items"] ?? {} : {},
          entries: adventure.items ?? {},
        },
      );
      if (embeddedPack) {
        publishTranslatedPackCompat(babele, state, `${packId}-items`, embeddedPack);
      }
    }
  }

  if (state) {
    trackMissingConverters(babele, state, packId, metadata, translation);
  }
  return true;
}

async function refreshPacksForConverters(babele, state, converterNames) {
  if (!state.packMissingConverters?.size) return;
  const targets = new Set(converterNames ?? []);
  if (!targets.size) return;

  for (const [packId, missing] of state.packMissingConverters.entries()) {
    const needsRefresh = Array.from(missing ?? []).some((name) => targets.has(name));
    if (!needsRefresh) continue;
    const translation = babele.translations?.find?.((t) => t?.collection === packId);
    if (!translation) continue;
    try {
      await rebuildTranslatedPack(babele, state, packId, translation);
      state.packMissingConverters.delete(packId);
    } catch {
    }
  }
}

async function refreshPacksForMapping(babele, state, mapping) {
  const types = Object.keys(mapping ?? {});
  if (!types.length) return;
  const typeSet = new Set(types);

  for (const packId of babele.packs?.keys?.() ?? []) {
    const metadata = getPackMetadata(babele, packId);
    if (!metadata || !typeSet.has(metadata.type)) continue;
    const translation = babele.translations?.find?.((t) => t?.collection === packId);
    if (!translation) continue;
    try {
      await rebuildTranslatedPack(babele, state, packId, translation);
    } catch {
    }
  }
}

function registerWrappers() {
  if (!game.modules?.get?.("lib-wrapper")?.active) {
    if (game.user?.isGM) {
      ui.notifications?.error?.("babele-ondemand-patch: libWrapper is required.");
    }
    return;
  }

  libWrapper.register(
    PATCH_ID,
    "CONFIG.DatabaseBackend._getDocuments",
    async function (wrapped, ...args) {
      tracePatch("_getDocuments enter", {
        mode: getLoadingModeSetting(),
        requestPack: normalizePackId(args?.[1]?.pack ?? null),
        requestIndex: !!(args?.[1]?.index ?? args?.[1]?.options?.index),
        documentClass: typeof args?.[0] === "function" ? args[0].name ?? "anonymous" : typeof args?.[0],
      });
      const result = await wrapped(...args);
      tracePatch("_getDocuments after wrapped", {
        resultType: Array.isArray(result) ? "array" : typeof result,
        resultCount: Array.isArray(result) ? result.length : null,
      });
      if (!isOnDemandMode()) return result;

      const babele = game.babele;
      if (!babele) return result;
      if (!babele.initialized) {
        try {
          tracePatch("_getDocuments forcing babele.init");
          await babele.init();
        } catch {
          tracePatch("_getDocuments init failed");
          return result;
        }
      }

      const request = args?.[1] ?? {};
      const packId = normalizePackId(request.pack);
      if (!packId) return result;

      const isIndex = request.index ?? request.options?.index;
      const state = babele.__ondemandPatch;
      if (!state) return result;
      tracePatch("_getDocuments state", snapshotPatchState(babele, state));

      if (isIndex) {
        try {
          tracePatch("_getDocuments translating index");
          translateIndexTitles(state, result, packId);
        } catch {
          tracePatch("_getDocuments index translation failed", { packId });
        }
        return result;
      }

      try {
        tracePatch("_getDocuments ensurePackTranslationsLoaded begin", { packId });
        await babele.ensurePackTranslationsLoaded?.(packId);
        tracePatch("_getDocuments ensurePackTranslationsLoaded end", {
          packId,
          translated: !!getTranslatedPackCompat(babele, state, packId),
          loaded: isPackTranslationLoadedCompat(babele, state, packId),
        });
      } catch {
        tracePatch("_getDocuments ensurePackTranslationsLoaded failed", { packId });
        return result;
      }

      if (!isPackTranslationLoadedCompat(babele, state, packId) && !babele.isTranslated?.(packId)) return result;

      const documentClass = args?.[0];
      if (!documentClass || !Array.isArray(result)) return result;

      try {
        tracePatch("_getDocuments translating documents", { packId, count: result.length });
        return result.map((doc) => {
          const source = typeof doc?.toObject === "function" ? doc.toObject() : doc;
          return reconstructDocumentCompat(documentClass, translateDataCompat(babele, state, packId, source), packId);
        });
      } catch {
        tracePatch("_getDocuments translation failed", { packId });
        return result;
      }
    },
    "WRAPPER",
  );

  libWrapper.register(
    PATCH_ID,
    "CompendiumCollection.prototype.initializeTree",
    function (wrapped, ...args) {
      tracePatch("initializeTree enter", {
        packId: normalizePackId(this),
        indexCount: this?.index?.size ?? this?.index?.length ?? null,
        folderCount: this?.folders?.size ?? 0,
      });
      const out = wrapped(...args);
      if (!isOnDemandMode()) return out;

      try {
        const babele = game.babele;
        const state = babele?.__ondemandPatch;
        const packId = normalizePackId(this);
        if (!babele || !state || !packId) return out;

        tracePatch("initializeTree applying title index", { packId });
        translateIndexTitles(state, this.index, packId);

        const folders = state.titleIndex?.[packId]?.folders ?? {};
        if (folders && this.folders?.size) {
          this.folders.forEach((folder) => {
            const translated = folders[folder.originalName ?? folder.name];
            if (translated) {
              folder.originalName = folder.originalName ?? folder.name;
              folder.name = translated;
            }
          });
        }
      } catch {
        tracePatch("initializeTree failed", { packId: normalizePackId(this) });
      }

      return out;
    },
    "WRAPPER",
  );

  libWrapper.register(
    PATCH_ID,
    "foundry.documents.collections.CompendiumCollection.prototype.indexDocument",
    function (wrapped, ...args) {
      tracePatch("indexDocument enter", {
        packId: normalizePackId(this),
        documentId: args?.[0]?.id ?? args?.[0]?._id ?? null,
      });
      const out = wrapped(...args);
      if (!isOnDemandMode()) return out;

      try {
        const document = args?.[0];
        const id = document?.id ?? document?._id;
        const packId = normalizePackId(this);
        const babele = game.babele;
        const state = babele?.__ondemandPatch;
        if (!id || !packId || !state) return out;

        const entry = this.index?.get?.(id);
        if (!entry) return out;

        if (entry.originalName == null) {
          entry.originalName = document?.originalName ?? document?.name ?? entry.name;
        }

        translateIndexTitles(state, [entry], packId);
        scheduleDocumentIndexRebuild(state, "indexDocument");
        tracePatch("indexDocument applied", {
          packId,
          documentId: id,
          entryName: entry?.name ?? null,
          originalName: entry?.originalName ?? null,
        });
      } catch {
        tracePatch("indexDocument failed", { packId: normalizePackId(this) });
      }

      return out;
    },
    "WRAPPER",
  );
}
