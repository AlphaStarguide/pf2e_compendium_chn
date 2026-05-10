const PATCH_ID = detectHostPackageId() ?? "babele-ondemand-patch";
const MODULE_ID = detectHostPackageId() ?? "pf2e_compendium_chn";

const BABEL_NAMESPACE = "babele";
const PATCH_NAMESPACE = MODULE_ID;
const SETTING_LOADING_MODE = "loadingMode";
const SETTING_LABELS = "labels";
const SETTING_TITLE_INDEX = "titleIndex";

const LOADING_MODES = {
  FULL: "full",
  ONDEMAND: "ondemand",
};

const TRANSLATION_DIRS = ["zh-CN", "compendium"];
const CHINESE_LANGUAGE_ALIASES = new Set(["cn", "zh-CN", "zh_Hans", "zh-Hans", "zh-cn", "zh_hans"]);

const state = {
  babele: null,
  patched: false,
  classes: null,
  lazyPacks: null,
  pendingPacks: new Map(),
  labels: null,
  titleIndex: null,
  availableDirs: null,
  originals: new WeakMap(),
  pendingQuickInsertRefresh: null,
  documentIndexRefreshQueued: false,
};

logPatch("module script loaded", { url: import.meta.url, patchId: PATCH_ID });

Hooks.once("babele.init", (babele) => {
  state.babele = babele;
  registerSettingsIfMissing();
  patchBabeleFacade(babele);
  registerDatabaseWrapper();
});

Hooks.once("ready", async () => {
  if (!isOnDemandMode()) return;
  await initializeLightweightIndexes();
});

Hooks.on("babele.ready", async () => {
  if (!isOnDemandMode()) return;
  await initializeLightweightIndexes();
});

Hooks.on("QuickInsert:IndexCompleted", () => {
  if (!isOnDemandMode()) return;
  applyTitleIndexToLoadedPackIndexes();
});

function logPatch(message, data = null) {
  try {
    if (data !== null) console.info(`[${PATCH_ID}] ${message}`, data);
    else console.info(`[${PATCH_ID}] ${message}`);
  } catch {
  }
}

function detectHostPackageId() {
  try {
    const match = String(import.meta.url ?? "").match(/\/modules\/([^/]+)\//);
    return match?.[1] ?? null;
  } catch {
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
      hint: "全量模式使用 Babele 原生启动加载；轻量模式保留旧选项名，但内部改为 Babele 2.8+ 懒加载：启动只加载 labels/titles，打开或索引具体合集包时再加载该包完整翻译。",
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

  const current = getLoadingModeSetting();
  syncPatchLoadingModeSetting(current);
}

function isValidLoadingMode(mode) {
  return mode === LOADING_MODES.FULL || mode === LOADING_MODES.ONDEMAND;
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
  try {
    const mode = game.settings?.get?.(BABEL_NAMESPACE, SETTING_LOADING_MODE);
    if (isValidLoadingMode(mode)) return mode;
  } catch {
  }
  return getPatchLoadingModeSetting() ?? LOADING_MODES.ONDEMAND;
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

function isOnDemandMode() {
  return getLoadingModeSetting() === LOADING_MODES.ONDEMAND;
}

function currentLanguage() {
  try {
    return game.settings?.get?.("core", "language") ?? "cn";
  } catch {
    return "cn";
  }
}

function isChineseLanguage(language = currentLanguage()) {
  return CHINESE_LANGUAGE_ALIASES.has(String(language ?? ""));
}

function patchBabeleFacade(babele) {
  if (!babele || state.patched) return;
  state.patched = true;

  const originals = {
    translatedCompendiumFor: babele.translatedCompendiumFor?.bind?.(babele),
    mappedCompendiumFor: babele.mappedCompendiumFor?.bind?.(babele),
    translateIndex: babele.translateIndex?.bind?.(babele),
    translate: babele.translate?.bind?.(babele),
    isTranslated: babele.isTranslated?.bind?.(babele),
    cacheDiagnostics: babele.cacheDiagnostics?.bind?.(babele),
  };
  state.originals.set(babele, originals);

  babele.translatedCompendiumFor = function patchedTranslatedCompendiumFor(pack) {
    const original = originals.translatedCompendiumFor?.(pack) ?? null;
    if (original) return original;
    return state.lazyPacks?.get?.(collectionId(pack)) ?? null;
  };

  babele.mappedCompendiumFor = function patchedMappedCompendiumFor(pack) {
    const original = originals.mappedCompendiumFor?.(pack) ?? null;
    if (original) return original;
    return state.lazyPacks?.get?.(collectionId(pack)) ?? null;
  };

  babele.isTranslated = function patchedIsTranslated(pack) {
    return !!(originals.isTranslated?.(pack) || state.lazyPacks?.get?.(collectionId(pack))?.translated);
  };

  babele.translateIndex = function patchedTranslateIndex(index, pack) {
    const translated = originals.translateIndex?.(index, pack) ?? index;
    const mapped = state.lazyPacks?.get?.(collectionId(pack)) ?? null;
    return mapped?.translated ? mapped.translateIndex(translated) : translated;
  };

  babele.translate = function patchedTranslate(pack, data, translationsOnly = false) {
    const translated = originals.translate?.(pack, data, translationsOnly) ?? data;
    const mapped = state.lazyPacks?.get?.(collectionId(pack)) ?? null;
    return mapped?.translated ? mapped.translate(translated, translationsOnly) : translated;
  };

  babele.cacheDiagnostics = function patchedCacheDiagnostics() {
    const base = originals.cacheDiagnostics?.() ?? {};
    return {
      ...base,
      pf2eCompendiumChnOnDemand: {
        enabled: isOnDemandMode(),
        loadedPackCount: state.lazyPacks?.size ?? state.lazyPacks?.contents?.length ?? 0,
        pendingPackCount: state.pendingPacks?.size ?? 0,
        labelsLoaded: !!state.labels,
        titleIndexLoaded: !!state.titleIndex,
        directories: state.availableDirs ?? [],
      },
    };
  };

  globalThis.game.pf2eCompendiumChn = {
    loadLabels,
    loadTitleIndex,
    ensurePackTranslationsLoaded,
    getTitle,
    applyTitleIndexToLoadedPackIndexes,
    rebuildDocumentIndex: rebuildDocumentIndexSafely,
    refreshQuickInsert: refreshQuickInsertIndex,
    diagnostics: () => babele.cacheDiagnostics(),
  };

  logPatch("patched Babele 2.8+ facade for on-demand mode");
}

function registerDatabaseWrapper() {
  if (!globalThis.libWrapper?.register) {
    console.warn(`[${PATCH_ID}] libWrapper is not available; on-demand document translation wrapper was not registered.`);
    return;
  }

  libWrapper.register(PATCH_ID, "CONFIG.DatabaseBackend._getDocuments", async function pf2eCompendiumChnGetDocumentsWrapper(wrapped, ...args) {
    const result = await wrapped(...args);

    if (!isOnDemandMode() || !Array.isArray(result) || result.length === 0) {
      return result;
    }

    const context = contextFromArgs(args);
    const packId = collectionId(context.pack);
    if (!packId) return result;

    const mapped = await ensurePackTranslationsLoaded(packId);
    if (!mapped?.translated) return result;

    if (context.index) {
      const translatedIndex = mapped.translateIndex(result);
      applyLabelForPack(packId);
      queueIndexRefreshes({ quickInsert: true, documentIndex: true });
      return translatedIndex;
    }

    return result.map((document) => translateDocument(document, context.documentClass, packId, mapped));
  }, "WRAPPER");

  logPatch("registered on-demand database translation wrapper");
}

function contextFromArgs(args = []) {
  const [documentClass, request = {}] = args;
  return {
    documentClass: typeof documentClass === "function" ? documentClass : null,
    request,
    pack: request?.pack ?? null,
    index: !!(request?.index ?? request?.options?.index),
  };
}

function translateDocument(document, documentClass, packId, mapped) {
  const source = documentSource(document);
  if (!source) return document;

  try {
    const translated = mapped.translate(source);
    if (!documentClass) return translated;
    return reconstructDocument(documentClass, translated, { pack: packId });
  } catch (error) {
    console.error(`[${PATCH_ID}] failed to translate document from '${packId}'`, {
      packId,
      documentId: source?._id ?? null,
      documentName: source?.name ?? null,
      error: error?.message ?? String(error),
    });
    return document;
  }
}

function documentSource(document) {
  if (!document) return null;
  if (typeof document.toObject === "function") return document.toObject();
  return typeof document === "object" ? document : null;
}

function reconstructDocument(documentClass, source, context) {
  if (typeof documentClass?.fromSource === "function") {
    return documentClass.fromSource(source, context);
  }
  return new documentClass(source, context);
}

async function initializeLightweightIndexes() {
  if (!isChineseLanguage()) return;
  await Promise.all([loadLabels(), loadTitleIndex()]);
  applyLabelsToPacks();
  applyTitleIndexToLoadedPackIndexes();
  queueIndexRefreshes({ quickInsert: true, documentIndex: true });
}

async function ensureBabeleInitialized() {
  if (!state.babele?.init) return;
  try {
    await state.babele.init();
  } catch (error) {
    console.warn(`[${PATCH_ID}] Babele init failed before lazy translation`, error);
  }
}

async function ensurePackTranslationsLoaded(pack) {
  const packId = collectionId(pack);
  if (!packId || !isChineseLanguage()) return null;

  const already = state.lazyPacks?.get?.(packId) ?? null;
  if (already?.translated) return already;

  if (state.pendingPacks.has(packId)) {
    return state.pendingPacks.get(packId);
  }

  const pending = (async () => {
    await ensureBabeleInitialized();
    const translation = await loadPackTranslation(packId);
    if (!translation) return null;

    const mapped = await createMappedCompendium(packId, translation);
    if (!mapped) return null;

    state.lazyPacks ??= new foundry.utils.Collection();
    state.lazyPacks.set(packId, mapped);

    const packObject = game.packs?.get?.(packId);
    if (packObject?.index) mapped.translateIndex(packObject.index);
    applyLabelForPack(packId);
    queueIndexRefreshes({ quickInsert: true, documentIndex: true });
    return mapped;
  })().finally(() => state.pendingPacks.delete(packId));

  state.pendingPacks.set(packId, pending);
  return pending;
}

async function createMappedCompendium(packId, translation) {
  const babele = state.babele ?? game.babele;
  if (!babele) return null;

  const classes = await importBabeleClasses();
  if (!classes?.MappedCompendium) return null;

  const metadata = metadataForPack(packId);
  if (!metadata) return null;

  const documentMappings = babele.documentMappings;
  if (!documentMappings?.supports?.(metadata.type)) return null;

  state.lazyPacks ??= new foundry.utils.Collection();

  return new classes.MappedCompendium(metadata, translation, {
    translationStrategies: babele.translationMatchStrategies?.() ?? [],
    documentMappings,
    language: currentLanguage(),
    runtimeFactory: (options = {}) => classes.CompendiumRuntime.from({
      globalPacks: state.lazyPacks,
      localPacks: options.localPacks ?? new foundry.utils.Collection(),
      currentCompendium: options.currentCompendium ?? null,
    }),
  });
}

async function importBabeleClasses() {
  if (state.classes) return state.classes;
  const [mappedModule, runtimeModule] = await Promise.all([
    import("/modules/babele/script/compendium/mapped-compendium.js"),
    import("/modules/babele/script/compendium/compendium-runtime.js"),
  ]);
  state.classes = {
    MappedCompendium: mappedModule.MappedCompendium ?? mappedModule.default ?? null,
    CompendiumRuntime: runtimeModule.CompendiumRuntime ?? runtimeModule.default ?? null,
  };
  return state.classes;
}

async function loadPackTranslation(packId) {
  const payloads = [];
  for (const dir of await availableTranslationDirs()) {
    const payload = await fetchJsonOrNull(`modules/${MODULE_ID}/${dir}/${packId}.json`);
    if (payload) payloads.push(payload);
  }
  return mergeTranslationPayloads(payloads);
}

async function loadLabels() {
  if (state.labels) return state.labels;

  const fromSettings = safeGetSetting(BABEL_NAMESPACE, SETTING_LABELS);
  if (fromSettings && Object.keys(fromSettings).length) {
    state.labels = fromSettings;
    return state.labels;
  }

  const labels = {};
  for (const dir of await availableTranslationDirs()) {
    const payload = await fetchJsonOrNull(`modules/${MODULE_ID}/${dir}/labels.json`);
    if (payload && typeof payload === "object") Object.assign(labels, payload);
  }

  state.labels = labels;
  safeSetSetting(BABEL_NAMESPACE, SETTING_LABELS, labels);
  return labels;
}

async function loadTitleIndex() {
  if (state.titleIndex) return state.titleIndex;

  const fromSettings = safeGetSetting(BABEL_NAMESPACE, SETTING_TITLE_INDEX);
  if (fromSettings && Object.keys(fromSettings).length) {
    state.titleIndex = fromSettings;
    return state.titleIndex;
  }

  const titleIndex = {};
  for (const dir of await availableTranslationDirs()) {
    const payload = await fetchJsonOrNull(`modules/${MODULE_ID}/${dir}/titles.json`);
    if (payload && typeof payload === "object") mergeTitleIndex(titleIndex, payload);
  }

  state.titleIndex = titleIndex;
  safeSetSetting(BABEL_NAMESPACE, SETTING_TITLE_INDEX, titleIndex);
  return titleIndex;
}

async function availableTranslationDirs() {
  if (state.availableDirs) return state.availableDirs;

  const available = [];
  for (const dir of TRANSLATION_DIRS) {
    const ok = await fileExists(`modules/${MODULE_ID}/${dir}/titles.json`) || await fileExists(`modules/${MODULE_ID}/${dir}/labels.json`);
    if (ok) available.push(dir);
  }

  state.availableDirs = available.length ? available : [...TRANSLATION_DIRS];
  return state.availableDirs;
}

async function fileExists(path) {
  try {
    const response = await fetch(path, { method: "HEAD" });
    return response?.ok !== false;
  } catch {
    try {
      const response = await fetch(path);
      return response?.ok !== false;
    } catch {
      return false;
    }
  }
}

async function fetchJsonOrNull(path) {
  try {
    const response = await fetch(path);
    if (response?.ok === false) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function mergeTranslationPayloads(payloads = []) {
  let merged = null;
  for (const payload of payloads.filter(Boolean)) {
    const clone = cloneData(payload);
    if (!merged) {
      merged = clone;
      continue;
    }

    merged.label = clone.label ?? merged.label;
    merged.mapping = mergePlainObject(merged.mapping, clone.mapping);
    merged.folders = mergePlainObject(merged.folders, clone.folders);

    if (clone.entries) {
      if (Array.isArray(merged.entries) || Array.isArray(clone.entries)) {
        merged.entries = [
          ...(Array.isArray(merged.entries) ? merged.entries : []),
          ...(Array.isArray(clone.entries) ? clone.entries : []),
        ];
      } else {
        merged.entries = mergePlainObject(merged.entries, clone.entries);
      }
    }

    if (clone.types) merged.types = [...new Set([...(merged.types ?? []), ...clone.types])];
    if (clone.reference) merged.reference = mergeArrayish(merged.reference, clone.reference);
    if (clone.extends) merged.extends = mergeArrayish(merged.extends, clone.extends);
  }
  return merged;
}

function mergePlainObject(a, b) {
  if (!a && !b) return undefined;
  return { ...(a ?? {}), ...(b ?? {}) };
}

function mergeArrayish(a, b) {
  const aa = a ? (Array.isArray(a) ? a : [a]) : [];
  const bb = b ? (Array.isArray(b) ? b : [b]) : [];
  return [...new Set([...aa, ...bb])];
}

function mergeTitleIndex(target, source) {
  for (const [packId, data] of Object.entries(source ?? {})) {
    const current = target[packId] ?? {};
    target[packId] = {
      ...current,
      ...data,
      titles: {
        ...(current.titles ?? {}),
        ...(data?.titles ?? {}),
      },
    };
  }
}

function cloneData(value) {
  if (value == null) return value;
  try {
    return foundry.utils?.deepClone ? foundry.utils.deepClone(value) : JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function safeGetSetting(namespace, key) {
  try {
    return game.settings?.get?.(namespace, key);
  } catch {
    return null;
  }
}

function safeSetSetting(namespace, key, value) {
  try {
    void game.settings?.set?.(namespace, key, value);
  } catch {
  }
}

function applyLabelsToPacks() {
  const labels = state.labels ?? {};
  for (const pack of game.packs ?? []) {
    const label = labels[pack.collection];
    if (!label || !pack.metadata) continue;
    const originalLabel = pack.metadata.originalLabel ?? pack.metadata.label;
    if (label === originalLabel) continue;
    pack.metadata.originalLabel = originalLabel;
    pack.metadata.label = label;
  }
}

function applyLabelForPack(packId) {
  const pack = game.packs?.get?.(packId);
  const label = state.labels?.[packId];
  if (!pack || !label || !pack.metadata) return;
  const originalLabel = pack.metadata.originalLabel ?? pack.metadata.label;
  if (label === originalLabel) return;
  pack.metadata.originalLabel = originalLabel;
  pack.metadata.label = label;
}

function applyTitleIndexToLoadedPackIndexes() {
  const index = state.titleIndex;
  if (!index) return;

  for (const pack of game.packs ?? []) {
    const titles = index[pack.collection]?.titles;
    if (!titles || !pack.index) continue;
    for (const entry of pack.index) {
      translateIndexEntryTitle(entry, titles);
      translateJournalPageTitles(entry, titles);
    }
  }
}

function translateIndexEntryTitle(entry, titles) {
  if (!entry?.name) return;
  const originalName = entry.originalName ?? entry.name;
  const translated = titles[originalName] ?? titles[entry.name];
  if (!translated || translated === entry.name) return;
  entry.originalName = originalName;
  entry.name = translated;
  entry.translated = true;
  entry.hasTranslation = true;
  entry.flags = foundry.utils.mergeObject(entry.flags ?? {}, {
    babele: {
      originalName,
      translated: true,
      hasTranslation: true,
    },
  }, { inplace: false });
}

function translateJournalPageTitles(entry, titles) {
  if (!Array.isArray(entry?.pages)) return;
  for (const page of entry.pages) {
    if (!page?.name) continue;
    const originalName = page.originalName ?? page.name;
    const translated = titles[`${entry.originalName ?? entry.name}::${originalName}`] ?? titles[originalName] ?? titles[page.name];
    if (!translated || translated === page.name) continue;
    page.originalName = originalName;
    page.name = translated;
  }
}

function getTitle(packId, originalName) {
  return state.titleIndex?.[collectionId(packId)]?.titles?.[originalName] ?? null;
}

function queueIndexRefreshes({ documentIndex = false, quickInsert = false } = {}) {
  if (documentIndex && !state.documentIndexRefreshQueued) {
    state.documentIndexRefreshQueued = true;
    setTimeout(async () => {
      state.documentIndexRefreshQueued = false;
      await rebuildDocumentIndexSafely();
    }, 100);
  }

  if (quickInsert && !state.pendingQuickInsertRefresh) {
    state.pendingQuickInsertRefresh = setTimeout(async () => {
      state.pendingQuickInsertRefresh = null;
      await refreshQuickInsertIndex();
    }, 300);
  }
}

async function rebuildDocumentIndexSafely() {
  const documentIndex = game.documentIndex;
  if (!documentIndex || typeof documentIndex.index !== "function") return;

  try {
    await documentIndex.ready;
    clearDocumentIndex(documentIndex);
    await documentIndex.index();
  } catch (error) {
    console.warn(`[${PATCH_ID}] failed to rebuild Foundry documentIndex`, error);
  }
}

function clearDocumentIndex(documentIndex) {
  for (const key of Object.keys(documentIndex?.trees ?? {})) delete documentIndex.trees[key];
  for (const key of Object.keys(documentIndex?.uuids ?? {})) delete documentIndex.uuids[key];
}

async function refreshQuickInsertIndex() {
  const quickInsert = globalThis.QuickInsert ?? game.modules?.get?.("quick-insert")?.api ?? null;
  if (!quickInsert?.forceIndex) return;
  try {
    await quickInsert.forceIndex();
  } catch (error) {
    console.warn(`[${PATCH_ID}] failed to refresh Quick Insert index`, error);
  }
}

function collectionId(pack) {
  if (!pack) return null;
  if (typeof pack === "string") return pack;
  return pack.collection ?? pack.metadata?.id ?? pack.metadata?.collection ?? null;
}

function metadataForPack(packId) {
  const pack = game.packs?.get?.(packId);
  if (pack?.metadata) {
    return {
      ...pack.metadata,
      id: pack.collection ?? packId,
    };
  }

  const metadata = [...(game.data?.packs ?? [])].find((p) => {
    const id = `${p.packageType === "world" ? "world" : p.packageName}.${p.name}`;
    return id === packId;
  });
  return metadata ? { ...metadata, id: packId } : null;
}
