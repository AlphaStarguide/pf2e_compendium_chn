Hooks.once("babele.init", (babele) => {
  if (!babele) return;

  const MODULE_ID = "pf2e_compendium_chn";
  const DIRS = ["zh-CN", "compendium"];
  const LANGS = ["cn", "zh-CN", "zh_Hans", "zh-Hans"];

  for (const lang of LANGS) {
    try {
      babele.register({
        module: MODULE_ID,
        lang,
        dirs: DIRS,
      });
    } catch (error) {
      console.warn(`[${MODULE_ID}] Failed to register Babele translation source for ${lang}.`, error);
    }
  }

  try {
    babele.registerConverters({
      "npc-portrait-path": (data, translations, dataObject, translatedCompendium, translationObject, runtime = {}, params = {}) => {
        const currentCompendium = runtime.currentCompendium?.() ?? translatedCompendium;
        return game.npcTrans?.portrait?.(data, translations, dataObject, currentCompendium, translationObject, runtime, params) ?? data;
      },
      "npc-token-translation": (data, translations, dataObject, translatedCompendium, translationObject, runtime = {}, params = {}) => {
        const currentCompendium = runtime.currentCompendium?.() ?? translatedCompendium;
        return game.npcTrans?.token?.(data, translations, dataObject, currentCompendium, translationObject, runtime, params) ?? data;
      },
      "npc-data-translation": (data, translations, dataObject, translatedCompendium, translationObject, runtime = {}, params = {}) => {
        const currentCompendium = runtime.currentCompendium?.() ?? translatedCompendium;
        return game.npcTrans?.data?.(data, translations, dataObject, currentCompendium, translationObject, runtime, params) ?? data;
      },
      "npc-item-translation": (data, translations, dataObject, translatedCompendium, translationObject, runtime = {}, params = {}) => {
        const currentCompendium = runtime.currentCompendium?.() ?? translatedCompendium;
        return game.npcTrans?.item?.(data, translations, dataObject, currentCompendium, translationObject, runtime, params) ?? data;
      },
    });
  } catch (error) {
    console.warn(`[${MODULE_ID}] Failed to register Babele converters.`, error);
  }
});
