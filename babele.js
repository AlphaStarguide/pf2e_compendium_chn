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

Hooks.once("babele.init", (babele) => {
	if (!babele) return;

	registerTranslationSources(babele);

	babele.registerConverters({
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
			return game.npcTrans.portrait(
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
			return game.npcTrans.token(data, translations, dataObject, currentCompendium, translationObject, runtime, params);
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
			return game.npcTrans.data(data, translations, dataObject, currentCompendium, translationObject, runtime, params);
		},

		"npc-item-translation": (
			data,
			translations,
			dataObject,
			translatedCompendium,
			translationObject,
			runtime = {},
			params = {},
		) => {
			const currentCompendium = runtime.currentCompendium?.() ?? translatedCompendium;
			return game.npcTrans.item(data, translations, dataObject, currentCompendium, translationObject, runtime, params);
		},
	});
});
