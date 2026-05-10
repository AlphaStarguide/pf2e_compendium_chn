const MODULE_ID = "pf2e_compendium_chn";
const TRANSLATION_DIRS = ["zh-CN", "compendium"];
const SUPPORTED_ZH_LANGS = ["cn", "zh-CN", "zh_Hans", "zh-Hans"];

Hooks.once("babele.init", (babele) => {
  if (!babele) return;
  for (const lang of SUPPORTED_ZH_LANGS) {
    try {
      babele.register({
        module: MODULE_ID,
        lang,
        dirs: TRANSLATION_DIRS,
      });
    } catch (error) {
      console.warn(`[${MODULE_ID}] Babele registration failed for '${lang}'.`, error);
    }
  }

  babele.registerConverters({
    "npc-portrait-path": (
      data,
      translations,
      dataObject,
      contextCompendium,
      allTranslations,
      runtime = {},
      params = {}
    ) => {
      const currentCompendium = runtime?.currentCompendium?.() ?? contextCompendium;
      return (
        game.npcTrans?.portrait?.(
          data,
          translations,
          dataObject,
          currentCompendium,
          allTranslations,
          runtime,
          params
        ) ?? data
      );
    },

    "npc-token-translation": (
      data,
      translations,
      dataObject,
      contextCompendium,
      allTranslations,
      runtime = {},
      params = {}
    ) => {
      const currentCompendium = runtime?.currentCompendium?.() ?? contextCompendium;
      return (
        game.npcTrans?.token?.(
          data,
          translations,
          dataObject,
          currentCompendium,
          allTranslations,
          runtime,
          params
        ) ?? data
      );
    },

    "npc-data-translation": (
      data,
      translations,
      dataObject,
      contextCompendium,
      allTranslations,
      runtime = {},
      params = {}
    ) => {
      const currentCompendium = runtime?.currentCompendium?.() ?? contextCompendium;
      return (
        game.npcTrans?.data?.(
          data,
          translations,
          dataObject,
          currentCompendium,
          allTranslations,
          runtime,
          params
        ) ?? data
      );
    },

    "npc-item-translation": (
      data,
      translations,
      dataObject,
      contextCompendium,
      allTranslations,
      runtime = {},
      params = {}
    ) => {
      const currentCompendium = runtime?.currentCompendium?.() ?? contextCompendium;
      return (
        game.npcTrans?.item?.(
          data,
          translations,
          dataObject,
          currentCompendium,
          allTranslations,
          runtime,
          params
        ) ?? data
      );
    },
  });
});
