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
const ACTOR_IMPORT_INTERNAL_OPTION = "__babeleOnDemandActorImportTranslate";

let capturedBabele = null;
let patched = false;

logPatch("module script loaded", { url: import.meta.url, patchId: PATCH_ID });

function logPatch(message, data = null) {
  try {
    if (data !== null) console.info(`[${PATCH_ID}] ${message}`, data);
    else console.info(`[${PATCH_ID}] ${message}`);
  } catch {
  }
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
  state.modernLoadedTranslations = state.modernLoadedTranslations ?? new Map();
  state.modernInjectionWarnings = state.modernInjectionWarnings ?? new Set();

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

  babele.translateActor = (actor) => {
    if (!actor) return state.original.translateActor?.(actor);
    const dialog = new PatchedOnDemandTranslateDialog(actor);
    dialog.render(true);
  };

  babele.init = async () => {
    if (!isOnDemandMode()) {
      return state.original.init?.();
    }
    if (babele.initialized) return true;

    await initOnDemand(babele, state);
    return true;
  };

  babele.translateIndex = (index, pack) => {
    if (!isOnDemandMode()) {
      return state.original.translateIndex?.(index, pack) ?? index;
    }

    const packId = normalizePackId(pack);
    if (!packId) return index;

    if (isPackTranslationLoadedCompat(babele, state, packId) || babele.isTranslated?.(packId)) {
      return state.original.translateIndex?.(index, packId) ?? index;
    }
    return babele.translateIndexTitles(index, packId);
  };

  babele.translatePackFolders = (pack) => {
    if (!isOnDemandMode()) {
      return state.original.translatePackFolders?.(pack);
    }

    if (!pack?.folders?.size) return;
    const packId = normalizePackId(pack);
    const folders = state.titleIndex?.[packId]?.folders ?? {};
    if (!folders || typeof folders !== "object") return;
    pack.folders.forEach((folder) => {
      if (folders[folder.name]) folder.name = folders[folder.name];
    });
  };

  Hooks.on("babele.ready", async () => {
    if (!isOnDemandMode()) return;

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

  game.babeleOnDemandPatch = game.babeleOnDemandPatch ?? {};
  game.babeleOnDemandPatch.getActorImportDebug = () => !!root.BabeleOnDemandPatchDebug.actorImport;
  game.babeleOnDemandPatch.setActorImportDebug = (enabled) => {
    root.BabeleOnDemandPatchDebug.actorImport = !!enabled;
    return root.BabeleOnDemandPatchDebug.actorImport;
  };
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
  if (!isModernBabele(state)) {
    babele.packs = new foundry.utils.Collection();
    babele.translations = [];
  }
  babele.folders = game.data?.folders;

  await loadGlobalMappingsOnce(babele, state);

  const files = await getTranslationFiles(babele, state);
  state.packTranslationUrls = buildPackTranslationUrlIndex(babele, files);

  await ensureSpecialFolderTranslationsLoaded(babele, state, files);

  try {
    state.labels = await loadLabels(babele);
    babele.applyLabels?.(state.labels);
  } catch {
  }

  try {
    state.titleIndex = await loadTitleIndex(babele);
  } catch {
    state.titleIndex = {};
  }

  babele.initialized = true;
  Hooks.callAll("babele.dataLoaded");
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
  if (isModernBabele(state) && typeof babele.translatedCompendiumFor === "function") {
    return babele.translatedCompendiumFor(packId) ?? state?.compatPacks?.get?.(packId) ?? null;
  }
  return babele.packs?.get?.(packId) ?? state?.compatPacks?.get?.(packId) ?? null;
}

function findLegacyTranslatedPackForData(babele, data) {
  return babele?.packs?.find?.((p) => p.translated && p.hasTranslation(data)) ?? null;
}

function isPackTranslationLoadedCompat(babele, state, packId) {
  if (!babele || !packId) return false;
  if (isModernBabele(state) && typeof babele.translatedCompendiumFor === "function") {
    return !!babele.translatedCompendiumFor(packId) || !!state?.compatPacks?.get?.(packId)?.translated;
  }
  return !!babele.packs?.get?.(packId)?.translated || !!state?.compatPacks?.get?.(packId)?.translated;
}

function translateDataCompat(babele, state, packId, data, translationsOnly = false) {
  if (!babele || typeof babele.translate !== "function") return data;
  let translated = babele.translate(packId, data, translationsOnly);
  if (state?.compatPacks?.get?.(packId)?.translated && !isMeaningfulActorTranslation(data, translated)) {
    translated = state.compatPacks.get(packId).translate(data, translationsOnly);
  }
  if (
    isModernBabele(state) &&
    state?.modernLoadedTranslations?.has?.(packId) &&
    !isMeaningfulActorTranslation(data, translated) &&
    !state.modernInjectionWarnings.has(packId)
  ) {
    state.modernInjectionWarnings.add(packId);
    console.warn(
      `[${PATCH_ID}] Translation payload for ${packId} was loaded, but Babele modern facade did not expose an injection path. Verify Babele 2.8 adapter implementation.`,
    );
  }
  return translated;
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
  if (state.translationFilesCache) return state.translationFilesCache;

  if (!game.user?.hasPermission?.("FILES_BROWSE")) {
    return game.settings.get(BABEL_NAMESPACE, "translationFiles") ?? [];
  }

  const dirs = getTranslationDirectories(babele, state);
  const files = [];
  for (const dir of dirs) {
    try {
      const result = await foundry.applications.apps.FilePicker.browse("data", dir);
      for (const f of result.files ?? []) files.push(f);
    } catch {
    }
  }
  state.translationFilesCache = files;
  return files;
}

async function getMappingFiles(babele, state) {
  if (state.mappingFilesCache) return state.mappingFilesCache;

  if (!game.user?.hasPermission?.("FILES_BROWSE")) {
    return game.settings.get(BABEL_NAMESPACE, "mappingFiles") ?? [];
  }

  const dirs = getMappingDirectories(babele, state);
  const files = [];
  for (const dir of dirs) {
    try {
      const result = await foundry.applications.apps.FilePicker.browse("data", dir);
      for (const f of result.files ?? []) {
        if (typeof f === "string" && isMappingFileName(f)) files.push(f);
      }
    } catch {
    }
  }
  state.mappingFilesCache = sortMappingFilesByDirectoryPreference(files);
  return state.mappingFilesCache;
}

async function loadGlobalMappingsOnce(babele, state) {
  if (state.globalMappingsLoaded) return;
  const mappingFiles = await getMappingFiles(babele, state);
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
  }
  state.globalMappingsLoaded = true;
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

function ensureModernMappedCompendiumRegistry(babele) {
  if (!babele) return null;
  if (babele.mappedCompendiums?.get && babele.mappedCompendiums?.translated && babele.mappedCompendiums?.translate) {
    if (!babele.mappedCompendiums.packs) {
      babele.mappedCompendiums.packs = new foundry.utils.Collection();
    }
    return babele.mappedCompendiums;
  }

  const packs = babele.mappedCompendiums?.packs ?? new foundry.utils.Collection();
  babele.mappedCompendiums = {
    packs,
    get(pack) {
      return this.packs.get(pack) ?? null;
    },
    translated(pack) {
      const compendium = this.get(pack);
      return compendium?.translated ? compendium : null;
    },
    translateIndex(index, pack) {
      return this.translated(pack)?.translateIndex(index) ?? index;
    },
    translate(pack, data, translationsOnly) {
      return this.translated(pack)?.translate(data, translationsOnly) ?? data;
    },
    translateField(pack, field, data) {
      return this.get(pack)?.translateField(field, data) ?? null;
    },
    extract(pack, data, options = {}) {
      return this.get(pack)?.extract(data, options);
    },
    extractField(pack, field, data) {
      return this.get(pack)?.extractField(field, data);
    },
    values() {
      return this.packs.values();
    },
    matching(predicate) {
      return [...this.values()].filter(predicate);
    },
  };

  return babele.mappedCompendiums;
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
    const registry = ensureModernMappedCompendiumRegistry(babele);
    registry?.packs?.set?.(packId, translatedPack);
    return;
  }

  babele.packs?.set?.(packId, translatedPack);
}

async function createTranslatedPackCompat(babele, state, metadata, translation) {
  if (!metadata || !translation) return null;

  const LegacyTranslatedCompendium = await importLegacyTranslatedCompendium();
  if (LegacyTranslatedCompendium) {
    return new LegacyTranslatedCompendium(metadata, translation);
  }

  if (isModernBabele(state)) {
    const mappedPack = await createModernMappedPackCompat(babele, metadata, translation);
    if (mappedPack) return mappedPack;

    const collection = getPackMetadataCollection(babele, metadata);
    if (!state.modernInjectionWarnings.has(collection)) {
      state.modernInjectionWarnings.add(collection);
      console.warn(`[${PATCH_ID}] Unable to create a Babele 2.8 mapped compendium adapter for ${collection}.`);
    }
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
    } else if (isModernBabele(state)) {
      state.modernLoadedTranslations.set(collection, foundry.utils.mergeObject(translation, { collection }));
    }
  }
}

async function loadLabels(babele) {
  const fromSettings = game.settings.get(BABEL_NAMESPACE, SETTING_LABELS) ?? {};
  const result = { ...(typeof fromSettings === "object" && !Array.isArray(fromSettings) ? fromSettings : {}) };

  const tryFetch = game.user?.hasPermission?.("FILES_BROWSE") || Object.keys(result).length === 0;
  if (!tryFetch) return result;

  const dirs = getTranslationDirectories(babele);
  for (const dir of dirs) {
    const base = dir.endsWith("/") ? dir.slice(0, -1) : dir;
    const url = `${base}/labels.json`;
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const json = await r.json();
      if (json && typeof json === "object") Object.assign(result, json);
    } catch {
    }
  }
  return result;
}

async function loadTitleIndex(babele) {
  const fromSettings = game.settings.get(BABEL_NAMESPACE, SETTING_TITLE_INDEX) ?? {};
  const index =
    typeof fromSettings === "object" && !Array.isArray(fromSettings)
      ? (foundry.utils?.deepClone ? foundry.utils.deepClone(fromSettings) : JSON.parse(JSON.stringify(fromSettings)))
      : {};

  const tryFetch = game.user?.hasPermission?.("FILES_BROWSE") || Object.keys(index).length === 0;
  if (!tryFetch) return index;

  const dirs = getTranslationDirectories(babele);
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
    }
  }
  return index;
}

function applyLabels(babele, labels) {
  if (!labels || typeof labels !== "object") return;

  try {
    for (const metadata of game.data?.packs ?? []) {
      const collection = collectionFromMetadata(babele, metadata);
      if (labels[collection]) metadata.label = labels[collection];
    }
  } catch {
  }

  try {
    game.packs?.forEach?.((pack) => {
      if (labels[pack.collection]) pack.metadata.label = labels[pack.collection];
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

  if (isModernBabele(state) && state.original.ensurePackTranslationsLoaded) {
    await state.original.ensurePackTranslationsLoaded(packId);
    if (isPackTranslationLoadedCompat(babele, state, packId) || babele.isTranslated?.(packId)) return;
  }

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
    }

    let urls = state.packTranslationUrls.get(packId);
    debugActorImport("尝试加载pack翻译", {
      packId,
      hasIndexedUrls: !!urls?.length,
      indexedUrlCount: urls?.length ?? 0,
    });
    let translation = urls?.length ? await loadTranslationFromUrls(urls) : null;

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
    }

    if (!translation) {
      debugActorImport("pack翻译加载失败（未找到可用json）", { packId });
      return;
    }

    const metadata = getPackMetadata(babele, packId);
    if (!metadata) return;

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
    } else if (isModernBabele(state)) {
      state.modernLoadedTranslations.set(packId, storedTranslation);
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
      for (const ref of refs) {
        await ensurePackTranslationsLoaded(babele, state, ref);
      }
    }
  })();

  state.packTranslationsLoading.set(packId, loader);
  try {
    await loader;
  } finally {
    state.packTranslationsLoading.delete(packId);
  }
}

async function loadTranslationFromUrls(urls) {
  const translations = await Promise.all(
    (urls ?? []).map(async (url) => {
      try {
        const r = await fetch(url);
        return await r.json();
      } catch {
        return null;
      }
    }),
  );

  return mergeTranslationPayloads(translations);
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
      const result = await wrapped(...args);
      if (!isOnDemandMode()) return result;

      const babele = game.babele;
      if (!babele) return result;
      if (!babele.initialized) {
        try {
          await babele.init();
        } catch {
          return result;
        }
      }

      const request = args?.[1] ?? {};
      const packId = normalizePackId(request.pack);
      if (!packId) return result;

      const isIndex = request.index ?? request.options?.index;
      const state = babele.__ondemandPatch;
      if (!state) return result;

      if (isIndex) {
        try {
          translateIndexTitles(state, result, packId);
        } catch {
        }
        return result;
      }

      try {
        await babele.ensurePackTranslationsLoaded?.(packId);
      } catch {
        return result;
      }

      if (!isPackTranslationLoadedCompat(babele, state, packId) && !babele.isTranslated?.(packId)) return result;

      const documentClass = args?.[0];
      if (!documentClass || !Array.isArray(result)) return result;

      try {
        return result.map((doc) => {
          const source = typeof doc?.toObject === "function" ? doc.toObject() : doc;
          return reconstructDocumentCompat(documentClass, translateDataCompat(babele, state, packId, source), packId);
        });
      } catch {
        return result;
      }
    },
    "WRAPPER",
  );

  libWrapper.register(
    PATCH_ID,
    "CompendiumCollection.prototype.initializeTree",
    function (wrapped, ...args) {
      const out = wrapped(...args);
      if (!isOnDemandMode()) return out;

      try {
        const babele = game.babele;
        const state = babele?.__ondemandPatch;
        const packId = normalizePackId(this);
        if (!babele || !state || !packId) return out;

        translateIndexTitles(state, this.index, packId);

        const folders = state.titleIndex?.[packId]?.folders ?? {};
        if (folders && this.folders?.size) {
          this.folders.forEach((folder) => {
            if (folders[folder.name]) folder.name = folders[folder.name];
          });
        }
      } catch {
      }

      return out;
    },
    "WRAPPER",
  );
}
