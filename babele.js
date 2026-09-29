// Modified 2026-09-29: shared Actor mappings and converter initialization.
// Based on AlphaStarguide/pf2e_compendium_chn; GPL-3.0, see LICENSE.
import { NPCTranslator } from "./npc/NPCTranslator.js";
import { createDefaultMappings, createDefaultConverters } from "./npc/default-mappings.js";

const MODULE_ID = "pf2e_compendium_chn";
const BABEL_NAMESPACE = "babele";
const SETTING_LOADING_MODE = "loadingMode";

const LOADING_MODES = {
	FULL: "full",
	ONDEMAND: "ondemand",
};

const TRANSLATION_DIRS = ["zh-CN", "compendium"];

const LANGUAGE_ALIASES = ["cn", "zh-CN", "zh_Hans", "zh-Hans", "zh-cn", "zh_hans"];

function isValidLoadingMode(mode) {
	return mode === LOADING_MODES.FULL || mode === LOADING_MODES.ONDEMAND;
}

function currentLoadingMode() {
	try {
		const mode = game.settings?.get?.(BABEL_NAMESPACE, SETTING_LOADING_MODE);
		return isValidLoadingMode(mode) ? mode : LOADING_MODES.ONDEMAND;
	} catch {
		return LOADING_MODES.ONDEMAND;
	}
}

function registerTranslationSources(babele) {
	if (!babele?.register) return;

	for (const lang of LANGUAGE_ALIASES) {
		for (const dir of TRANSLATION_DIRS) {
			babele.register({
				module: MODULE_ID,
				lang,
				dir,
			});
		}
	}
}

function npcTranslator() {
	// Babele can translate documents before Foundry's ready hook runs.
	return (game.npcTrans ??= NPCTranslator.get());
}

function changedFields(original, translated) {
    if (original === translated) return undefined;
	// These converters own a whole branch, but should not undo an earlier
	// mapping for a child field that they did not change.
	const changes = foundry.utils.diffObject(original, translated);
	return Object.keys(changes).length ? changes : undefined;
}

Hooks.once("babele.init", (babele) => {
	if (!babele) return;
	// Start the dictionary request before async pack initialization/loading waits
	// for game.npcTrans.dict.ready. Converters themselves stay synchronous.
	npcTranslator();

	registerTranslationSources(babele);

	babele.registerConverters({
		...createDefaultConverters(),
		"npc-portrait-path": (
			data,
			translations,
			dataObject,
			translatedCompendium,
			translationObject,
			runtime = {},
			params = {},
		) => {
			const currentCompendium = runtime.currentCompendium?.() ?? translatedCompendium;
			return npcTranslator().portrait(
				data,
				translations,
				dataObject,
				currentCompendium,
				translationObject,
				runtime,
				params,
			);
		},

		"npc-token-translation": (
			data,
			translations,
			dataObject,
			translatedCompendium,
			translationObject,
			runtime = {},
			params = {},
		) => {
			const currentCompendium = runtime.currentCompendium?.() ?? translatedCompendium;
			return changedFields(data, npcTranslator().token(data, translations, dataObject, currentCompendium, translationObject, runtime, params));
		},

		"npc-data-translation": (
			data,
			translations,
			dataObject,
			translatedCompendium,
			translationObject,
			runtime = {},
			params = {},
		) => {
			const currentCompendium = runtime.currentCompendium?.() ?? translatedCompendium;
			return changedFields(data, npcTranslator().data(data, translations, dataObject, currentCompendium, translationObject, runtime, params));
		},

		// Translation-only: keep embedded Item export disabled. Reliable source
		// comparison would require loading original compendium documents.
		"npc-item-translation": {
			translate({ value, translation, source, contextCompendium, allTranslations, runtime = {}, params = {} }) {
				const currentCompendium = runtime.currentCompendium?.() ?? contextCompendium;
				return npcTranslator().item(value, translation, source, currentCompendium, allTranslations, runtime, params);
			},
			extract() {
				return undefined;
			},
		},
	});

	if (game.system.id === "pf2e" && LANGUAGE_ALIASES.includes(game.i18n.lang)) {
		babele.registerMapping(createDefaultMappings());
	}
});
