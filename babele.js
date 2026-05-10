Hooks.once("babele.init", (babele) => {
  if (!babele) return;

  babele.register({
    module: "pf2e_compendium_chn",
    lang: "cn",
    dir: "zh-CN",
  });

  babele.register({
    module: "pf2e_compendium_chn",
    lang: "zh-CN",
    dir: "zh-CN",
  });

  babele.register({
    module: "pf2e_compendium_chn",
    lang: "zh_Hans",
    dir: "zh-CN",
  });

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
