const PATCH_ID = detectHostPackageId() ?? "babele-ondemand-patch";

const BABEL_NAMESPACE = "babele";
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

let capturedBabele = null;
let patched = false;

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
  capturedBabele = babele;
});

Hooks.once("init", () => {
  registerSettingsIfMissing();
  registerWrappers();

  if (capturedBabele) {
    tryPatchBabele(capturedBabele);
  }
});

Hooks.once("ready", () => {
  if (!patched && game.babele) {
    tryPatchBabele(game.babele);
  }
});

function registerSettingsIfMissing() {
  const settings = game.settings?.settings;
  if (!settings) return;

  if (!settings.has(`${BABEL_NAMESPACE}.${SETTING_LOADING_MODE}`)) {
    game.settings.register(BABEL_NAMESPACE, SETTING_LOADING_MODE, {
      name: "Loading Mode",
      hint: "Full loads all translations at startup. On-demand loads only labels/titles at startup and fetches full pack translations when documents are opened.",
      type: String,
      scope: "world",
      config: true,
      choices: {
        [LOADING_MODES.FULL]: "Full (traditional)",
        [LOADING_MODES.ONDEMAND]: "On-demand (fast startup)",
      },
      default: LOADING_MODES.ONDEMAND,
      onChange: () => window.location.reload(),
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

function isOnDemandMode() {
  try {
    const mode = game.settings?.get?.(BABEL_NAMESPACE, SETTING_LOADING_MODE);
    return mode === LOADING_MODES.ONDEMAND;
  } catch {
    return false;
  }
}

function tryPatchBabele(babele) {
  if (patched) return;
  if (!babele) return;

  const stateKey = "__ondemandPatch";
  if (babele[stateKey]?.patched) {
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

  babele.isFullMode = () => !isOnDemandMode();
  babele.translateIndexTitles = (index, pack) => translateIndexTitles(state, index, pack);
  babele.applyLabels = (labels = null) => applyLabels(babele, labels ?? state.labels);
  babele.applyTitleIndex = (titleIndex = null) => {
    state.titleIndex = titleIndex ?? state.titleIndex ?? {};
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

  babele.registerConverters = (converters = {}) => {
    const result = state.original.registerConverters?.(converters);
    if (!isOnDemandMode()) return result;
    const names = Object.keys(converters ?? {});
    if (!names.length) return result;
    void refreshPacksForConverters(babele, state, names);
    return result;
  };

  babele.registerMapping = (mapping) => {
    const result = state.original.registerMapping?.(mapping);
    if (!isOnDemandMode()) return result;
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
    if (babele.initialized) return;

    await initOnDemand(babele, state);
  };

  babele.translateIndex = (index, pack) => {
    if (!isOnDemandMode()) {
      return state.original.translateIndex?.(index, pack) ?? index;
    }

    const packId = normalizePackId(pack);
    if (!packId) return index;

    if (babele.isTranslated?.(packId)) {
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

  patched = true;
}

function getSourcePackId(itemData) {
  const sourceId = itemData?.flags?.core?.sourceId || itemData?._stats?.compendiumSource;
  const ref = sourceId ? foundry.utils.parseUuid(sourceId) : null;
  return ref?.collection ?? null;
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
                let pack = sourcePackId ? game.babele?.packs?.get?.(sourcePackId) : null;
                if (!pack || !pack.translated || !pack.hasTranslation(data)) {
                  pack = game.babele?.packs?.find?.((p) => p.translated && p.hasTranslation(data));
                }

                if (pack) {
                  const translatedData = pack.translate(data, true);
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
  babele.packs = new foundry.utils.Collection();
  babele.folders = game.data?.folders;
  babele.translations = [];

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

function getTranslationDirectories(babele) {
  const lang = game.settings.get("core", "language");
  const directory = game.settings.get(BABEL_NAMESPACE, "directory");
  const dirs = (babele.modules ?? [])
    .filter((m) => m?.lang === lang)
    .map((m) => `modules/${m.module}/${m.dir}`);

  if (directory && directory.trim && directory.trim()) {
    dirs.push(`${directory}/${lang}`);
  }
  if (babele.systemTranslationsDir) {
    dirs.push(`systems/${game.system.id}/${babele.systemTranslationsDir}/${lang}`);
  }
  return dirs;
}

function getMappingDirectories(babele) {
  const directory = game.settings.get(BABEL_NAMESPACE, "directory");
  const dirs = (babele.modules ?? []).map((m) => `modules/${m.module}/${m.dir}`);
  if (directory && directory.trim && directory.trim()) {
    dirs.push(`${directory}`);
  }
  if (babele.systemTranslationsDir) {
    dirs.push(`systems/${game.system.id}/${babele.systemTranslationsDir}`);
  }
  return dirs;
}

async function getTranslationFiles(babele, state) {
  if (state.translationFilesCache) return state.translationFilesCache;

  if (!game.user?.hasPermission?.("FILES_BROWSE")) {
    return game.settings.get(BABEL_NAMESPACE, "translationFiles") ?? [];
  }

  const dirs = getTranslationDirectories(babele);
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

  const dirs = getMappingDirectories(babele);
  const files = [];
  for (const dir of dirs) {
    try {
      const result = await foundry.applications.apps.FilePicker.browse("data", dir);
      for (const f of result.files ?? []) {
        if (typeof f === "string" && f.endsWith("/mapping.json")) files.push(f);
      }
    } catch {
    }
  }
  state.mappingFilesCache = files;
  return files;
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
    if (!babele.supported?.(metadata)) continue;
    const collection = babele.getCollection(metadata);
    const fileName = encodeURI(`${collection}.json`);
    const urls = (files ?? []).filter((f) => f?.split?.("/").pop?.().split?.("\\").pop?.() === fileName);
    if (urls.length) index.set(collection, urls);
  }
  return index;
}

async function ensureSpecialFolderTranslationsLoaded(babele, state, files) {
  if (!babele.folders) return;
  const suffix = babele.constructor?.PACK_FOLDER_TRANSLATION_NAME_SUFFIX ?? "_packs-folders";
  const folderFiles = (files ?? []).filter((f) => typeof f === "string" && f.endsWith(`${suffix}.json`));
  if (!folderFiles.length) return;

  const { TranslatedCompendium } = await import("/modules/babele/script/translated-compendium.js");

  for (const file of folderFiles) {
    const baseName = file.split("/").pop().split("\\").pop();
    const [packageName, name] = baseName.split(".");
    const collection = `${packageName}.${name}`;
    if (babele.packs.get(collection)?.translated) continue;

    const translation = await loadTranslationFromUrls([file]);
    if (!translation) continue;

    const metadata = { packageType: "system", type: "Folder", packageName, name };
    babele.packs.set(collection, new TranslatedCompendium(metadata, translation));
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
      const collection = babele.getCollection(metadata);
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

  if (babele.packs?.get?.(packId)?.translated) return;

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

    const urls = state.packTranslationUrls.get(packId);
    if (!urls?.length) return;

    const translation = await loadTranslationFromUrls(urls);
    if (!translation) return;

    const { TranslatedCompendium } = await import("/modules/babele/script/translated-compendium.js");
    const metadata = (game.data?.packs ?? []).find((m) => babele.getCollection(m) === packId);
    if (!metadata) return;

    if (!state.npcDepsLoaded && !state.npcDepsLoading) {
      const needsNpcDeps = mappingUsesConverters(translation.mapping, NPC_TRANSLATOR_CONVERTERS);
      if (needsNpcDeps) {
        await ensureNpcDependenciesLoaded(babele, state, packId);
      }
    }

    trackMissingConverters(babele, state, packId, metadata, translation);

    babele.packs.set(packId, new TranslatedCompendium(metadata, translation));
    const storedTranslation = foundry.utils.mergeObject(translation, { collection: packId });
    if (Array.isArray(babele.translations)) {
      const idx = babele.translations.findIndex((t) => t?.collection === packId);
      if (idx >= 0) {
        babele.translations[idx] = storedTranslation;
      } else {
        babele.translations.push(storedTranslation);
      }
    } else {
      babele.translations = [storedTranslation];
    }

    if (metadata.type === "Adventure" && translation.entries) {
      const entries = translation.entries;
      Object.values(Array.isArray(entries) ? entries : entries || {}).forEach((adventure) =>
        babele.packs.set(
          `${packId}-items`,
          new TranslatedCompendium(
            { type: "Item" },
            {
              mapping: translation.mapping ? translation.mapping["items"] ?? {} : {},
              entries: adventure.items ?? {},
            },
          ),
        ),
      );
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

  let translation = null;
  for (const t of translations.filter(Boolean)) {
    if (!translation) {
      translation = t;
      continue;
    }

    translation.label = t.label ?? translation.label;

    if (t.entries) {
      if (Array.isArray(translation.entries) || Array.isArray(t.entries)) {
        const a = Array.isArray(translation.entries) ? translation.entries : [];
        const b = Array.isArray(t.entries) ? t.entries : [];
        translation.entries = a.concat(b);
      } else {
        translation.entries = { ...(translation.entries ?? {}), ...(t.entries ?? {}) };
      }
    }

    if (t.mapping) {
      translation.mapping = { ...(translation.mapping ?? {}), ...(t.mapping ?? {}) };
    }

    if (t.folders) {
      translation.folders = { ...(translation.folders ?? {}), ...(t.folders ?? {}) };
    }

    if (t.types) {
      const a = Array.isArray(translation.types) ? translation.types : [];
      const b = Array.isArray(t.types) ? t.types : [];
      translation.types = Array.from(new Set(a.concat(b)));
    }

    if (t.reference) {
      const a = translation.reference ? (Array.isArray(translation.reference) ? translation.reference : [translation.reference]) : [];
      const b = Array.isArray(t.reference) ? t.reference : [t.reference];
      translation.reference = Array.from(new Set(a.concat(b)));
    }
  }

  return translation;
}

function getMergedMapping(babele, metadata, translation) {
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
  try {
    const merged = getMergedMapping(babele, metadata, translation);
    const missing = collectMissingConverters(babele, merged);
    if (missing.size) state.packMissingConverters.set(packId, missing);
    else state.packMissingConverters.delete(packId);
  } catch {
  }
}

function getPackMetadata(babele, packId) {
  return (game.data?.packs ?? []).find((m) => babele.getCollection(m) === packId);
}

async function rebuildTranslatedPack(babele, state, packId, translation) {
  const metadata = getPackMetadata(babele, packId);
  if (!metadata) return false;
  const { TranslatedCompendium } = await import("/modules/babele/script/translated-compendium.js");
  babele.packs.set(packId, new TranslatedCompendium(metadata, translation));

  if (metadata.type === "Adventure" && translation.entries) {
    const entries = translation.entries;
    Object.values(Array.isArray(entries) ? entries : entries || {}).forEach((adventure) =>
      babele.packs.set(
        `${packId}-items`,
        new TranslatedCompendium(
          { type: "Item" },
          {
            mapping: translation.mapping ? translation.mapping["items"] ?? {} : {},
            entries: adventure.items ?? {},
          },
        ),
      ),
    );
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

      if (!babele.isTranslated?.(packId)) return result;

      const documentClass = args?.[0];
      if (!documentClass || !Array.isArray(result)) return result;

      try {
        return result.map((doc) => {
          const source = typeof doc?.toObject === "function" ? doc.toObject() : doc;
          return new documentClass(babele.translate(packId, source), { pack: packId });
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
