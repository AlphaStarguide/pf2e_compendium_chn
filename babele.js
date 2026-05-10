Hooks.once("babele.init", (babele) => {
  if (!babele) return;

  const MODULE_ID = "pf2e_compendium_chn";
  const TRANSLATION_DIRS = ["compendium", "zh-CN"];
  const languages = ["cn", "zh-CN", "zh_Hans", "zh-Hans"];

  for (const lang of languages) {
    for (const dir of TRANSLATION_DIRS) {
      babele.register({
        module: MODULE_ID,
        lang,
        dir,
      });
    }
  }

  babele.registerConverters({
    "npc-portrait-path": (data, translations, dataObject, translatedCompendium, translationObject, runtime = {}, params = {}) => {
      const currentCompendium = runtime.currentCompendium?.() ?? translatedCompendium;
      return game.npcTrans.portrait(data, translations, dataObject, currentCompendium, translationObject, runtime, params);
    },
    "npc-token-translation": (data, translations, dataObject, translatedCompendium, translationObject, runtime = {}, params = {}) => {
      const currentCompendium = runtime.currentCompendium?.() ?? translatedCompendium;
      return game.npcTrans.token(data, translations, dataObject, currentCompendium, translationObject, runtime, params);
    },
    "npc-data-translation": (data, translations, dataObject, translatedCompendium, translationObject, runtime = {}, params = {}) => {
      const currentCompendium = runtime.currentCompendium?.() ?? translatedCompendium;
      return game.npcTrans.data(data, translations, dataObject, currentCompendium, translationObject, runtime, params);
    },
    "npc-item-translation": (data, translations, dataObject, translatedCompendium, translationObject, runtime = {}, params = {}) => {
      const currentCompendium = runtime.currentCompendium?.() ?? translatedCompendium;
      return game.npcTrans.item(data, translations, dataObject, currentCompendium, translationObject, runtime, params);
    },
  });
});
