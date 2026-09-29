// Modified 2026-09-29: compatible Actor text fields and independent token naming.
// Based on AlphaStarguide/pf2e_compendium_chn; GPL-3.0, see LICENSE.
import {DocumentTranslation} from "../../babele/script/translation/document-translation.js";
import {resolveActiveMapping} from "./default-mappings.js";
import {EmbeddedCompendium} from "../../babele/script/compendium/embedded-compendium.js";

function isTranslationObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Only fill existing text fields: never replace numbers or whole schema branches.
function setTranslatedText(target, path, ...values) {
    const value = values.find((candidate) => typeof candidate === "string");
    if (value === undefined) return;
    const keys = path.split(".");
    const key = keys.pop();
    let parent = target;
    for (const part of keys) parent = parent?.[part];
    if (parent && Object.hasOwn(parent, key) && typeof parent[key] === "string") parent[key] = value;
}

function applyFlatActorText(data, translations, original, mapping = {}) {
    const fields = [
        ["details.publicNotes", "publicNotes"],
        ["details.privateNotes", "privateNotes"],
        ["details.blurb", "blurb"],
        ["attributes.ac.details", "ac"],
        ["attributes.hp.details", "hp"],
        ["attributes.allSaves.value", "allSaves"],
        ["attributes.speed.details", "speed"],
        ["details.description", "hazarddescription"],
        // Older packs can retain English in the new aliases while the old
        // hazard-prefixed aliases contain the actual translation.
        ["details.disable", "hazarddisable", "disable"],
        ["details.routine", "hazardroutine", "routine"],
        ["details.reset", "hazardreset", "reset"],
        ["attributes.stealth.details", "stealthdetails"],
    ];
    for (const [path, ...keys] of fields) {
        // Independent fields own their paths, including compendium overrides.
        // Do not also write the default path through this legacy fallback.
        if (keys.some((key) => Object.hasOwn(mapping, key))) continue;
        const originalValue = path.split(".").reduce((value, key) => value?.[key], original);
        const currentValue = path.split(".").reduce((value, key) => value?.[key], data);
        const values = keys.map((key) => translations[key]).filter((value) => typeof value === "string");
        // An exported English placeholder must not undo an existing nested
        // translation or a dictionary result. Explicit changed values win.
        const value = values.find((candidate) => candidate !== originalValue)
            ?? (currentValue === originalValue ? values[0] : undefined);
        setTranslatedText(data, path, value);
    }
}

// Overlay only fields actually changed by a translation. Embedded document
// arrays are matched by ID; structured arrays retain unchanged fallback fields.
function sameValue(left, right) {
    if (left === right) return true;
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left) && Array.isArray(right) && left.length === right.length
            && left.every((value, index) => sameValue(value, right[index]));
    }
    if (!isTranslationObject(left) || !isTranslationObject(right)) return false;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].every((key) => sameValue(left[key], right[key]));
}

function overlayTranslation(base, original, translated, onlyMissing = false) {
    if (sameValue(original, translated)) return base;
    if (Array.isArray(translated) && Array.isArray(original) && Array.isArray(base)) {
        const keyed = [...original, ...translated, ...base].every((value) => typeof value?._id === "string");
        if (keyed) {
            const originalById = new Map(original.map((value) => [value._id, value]));
            const baseById = new Map(base.map((value) => [value._id, value]));
            const translatedById = new Map(translated.map((value) => [value._id, value]));
            const originalIds = original.map((value) => value._id);
            const translatedIds = translated.map((value) => value._id);
            // Preserve fallback order for text-only edits. An explicit array
            // insertion/removal/reorder is structural and must take effect.
            const order = sameValue(originalIds, translatedIds) ? base.map((value) => value._id)
                : [...translatedIds, ...base.filter((value) => !originalById.has(value._id)
                    && !translatedById.has(value._id)).map((value) => value._id)];
            return order.map((id) => translatedById.has(id)
                ? overlayTranslation(baseById.get(id), originalById.get(id), translatedById.get(id), onlyMissing)
                : baseById.get(id));
        }
        if (translated.length === original.length && base.length === original.length) {
            return translated.map((value, index) => overlayTranslation(base[index], original[index], value, onlyMissing));
        }
    }
    if (isTranslationObject(translated) && isTranslationObject(original)) {
        const result = isTranslationObject(base) ? { ...base } : {};
        for (const [key, value] of Object.entries(translated)) {
            if (sameValue(original[key], value)) continue;
            result[key] = overlayTranslation(result[key], original[key], value, onlyMissing);
        }
        return result;
    }
    return onlyMissing && !sameValue(base, original) ? base : foundry.utils.deepClone(translated);
}

// Babele's normal translate entry point intentionally skips already translated
// documents. An explicit local override is a new layer, so clear that transient
// gate on a detached working copy, including embedded effects, never the source.
function translationInput(source, restoreNames = false) {
    const result = foundry.utils.deepClone(source);
    const visit = (value) => {
        if (!value || typeof value !== "object") return;
        const isDocument = value === result || typeof value._id === "string";
        if (isDocument && Object.hasOwn(value, "translated")) value.translated = false;
        const originalName = value.originalName ?? value.flags?.babele?.originalName;
        if (isDocument && restoreNames && typeof originalName === "string") value.name = originalName;
        for (const child of Object.values(value)) {
            if (Array.isArray(child)) child.forEach(visit);
            else if (isTranslationObject(child) && typeof child._id === "string") visit(child);
        }
    };
    visit(result);
    return result;
}

function mappingPath(definition, source) {
    if (typeof definition === "string") return definition;
    if (definition?.converter === "pf2e-actor-system-text") {
        const path = definition.paths?.[source?.type] ?? definition.paths?.default;
        return path ? `${definition.path ?? "system"}.${path}` : undefined;
    }
    return definition?.path;
}

function findItemTranslation(translations, item, name = item.name) {
    const names = Array.isArray(name) ? name : [name];
    if (Array.isArray(translations)) {
        return translations.find((entry) => entry?.id === item._id)
            ?? names.map((key) => translations.find((entry) => entry?.id === key)).find((entry) => entry !== undefined);
    }
    if (isTranslationObject(translations)) {
        const keys = [item._id, ...names];
        return keys.filter((key) => Object.hasOwn(translations, key)).map((key) => translations[key])
            .find((entry) => entry !== undefined && entry !== null);
    }
    return undefined;
}

function localItemMapping(translatedCompendium, params = {}) {
    if (isTranslationObject(params?.mapping)) return params.mapping;
    const local = translatedCompendium?.customMapping?.items;
    if (isTranslationObject(local?.mapping)) return local.mapping;
    // Older files put child Item fields directly under mapping.items.
    if (isTranslationObject(local) && !Object.hasOwn(local, "path") && !Object.hasOwn(local, "converter")) return local;
    return {};
}

// Register token setting
Hooks.once("init", () => {
    game.settings.register("pf2e_compendium_chn", "token", {
        name: "是否将肖像设置为指示物Token",
        hint: "从合集包中导入翻译NPC时，是否使用肖像作为指示物Token，而不是常规Token？",
        scope: "world",
        type: Boolean,
        config: false,
        default: false,
    });
});

// Create an NPCTranslator instance
Hooks.once("ready", async () => {
    game.npcTrans = NPCTranslator.get();
});

export class NPCTranslator {
    static get() {
        if (!NPCTranslator.instance) {
            NPCTranslator.instance = new NPCTranslator();
        }
        return NPCTranslator.instance;
    }

    constructor() {
        this.dict = new Dictionary();
        this.mediaPath = new Map();
    }

    // Sluggify a string
    sluggify(label) {
        return label
            .replace(/([a-z])([A-Z])\B/g, "$1-$2")
            .toLowerCase()
            .replace(/'/g, "")
            .replace(/[^a-z0-9]+/gi, " ")
            .trim()
            .replace(/[-\s]+/g, "-");
    }

    // Register a madia path for a translated compendium containing portrait and token images
    addMediaPath(source, path) {
        this.mediaPath.set(source, path);
    }

    // Create the correct file path for the npc portrait image
    portrait(data, translations, dataObject, translatedCompendium, translationObject) {
        if (
            translationObject?.name &&
            dataObject?.type === "npc" &&
            this.mediaPath.get(translatedCompendium?.metadata?.label)
        ) {
            return this.mediaPath
                .get(translatedCompendium.metadata.label)
                .concat("portraits/p-", this.sluggify(dataObject.originalName ?? dataObject.flags?.babele?.originalName ?? dataObject.name), ".webp");
        }
        return data;
    }

    // Create the correct file path for the npc token image and translate the token name
    token(data, translations, dataObject, translatedCompendium, translationObject) {
        if (!isTranslationObject(data)) return data;
        translationObject = isTranslationObject(translationObject) ? translationObject : {};
        translations = isTranslationObject(translations) ? translations : {};
        data = foundry.utils.deepClone(data);
        const mapping = resolveActiveMapping(translatedCompendium?.mapping?.mapping ?? {}, dataObject);
        const ownsTokenName = !Object.hasOwn(mapping, "tokenName")
            || mappingPath(mapping.tokenName, dataObject) === "prototypeToken.name";
        const names = [
            typeof translationObject.prototypeToken === "string"
                ? translationObject.prototypeToken : translationObject.prototypeToken?.name,
            translationObject.data?.tokenName,
            translations.name,
            ownsTokenName ? translationObject.tokenName : undefined,
            translationObject.name,
        ].filter((value) => typeof value === "string" && value.trim().length > 0);
        const sourceNames = new Set([
            dataObject?.originalName,
            dataObject?.flags?.babele?.originalName,
        ].filter((value) => typeof value === "string"));
        if (sourceNames.size === 0 && typeof dataObject?.name === "string") sourceNames.add(dataObject.name);
        // Exported prototypeToken.name can still be the original actor name.
        // Prefer a translated candidate, while retaining distinct custom labels.
        const name = names.find((value) => !sourceNames.has(value)) ?? names[0];
        if (name !== undefined) data.name = name;

        // Naming is independent of optional portrait/token artwork.
        const mediaPath = this.mediaPath.get(translatedCompendium?.metadata?.label);
        if (translationObject.name && mediaPath) {
            if (dataObject?.type === "npc") {
                const prefix = game.settings.get("pf2e_compendium_chn", "token") ? "portraits/p-" : "tokens/t-";
                const image = mediaPath.concat(prefix, this.sluggify(dataObject.originalName ?? dataObject.flags?.babele?.originalName ?? dataObject.name), ".webp");
                if (isTranslationObject(data.texture)) data.texture.src = image;
                else data.img = image;
            }
        }
        return data;
    }

    // Translate the various elements within actor.system
    data(data, translations, dataObject, translatedCompendium, translationObject) {
        if (!isTranslationObject(data)) return data;
        if (!["npc", "hazard", "character", "familiar"].includes(dataObject?.type)) return data;
        translationObject = isTranslationObject(translationObject) ? translationObject : {};
        translations = isTranslationObject(translations) ? translations : {};
        const original = data;
        data = foundry.utils.deepClone(data);
        if (isTranslationObject(translations)) {
            // Explicit translations work even while the optional dictionary is loading.
            const fromDictionary = (method, value) =>
                this.dict.translations ? this.dict[method](value) ?? value : value;
            // Translate various singular text fields
            if (data.attributes?.ac?.details) {
                data.attributes.ac.details =
                    fromDictionary("translateAcDetails", data.attributes.ac.details);
            }

            if (data.attributes?.allSaves?.value) {
                data.attributes.allSaves.value =
                    fromDictionary("translateSave", data.attributes.allSaves.value);
            }

            setTranslatedText(data, "details.blurb", translations.blurb);

            if (data.details?.ethnicity?.value) {
                data.details.ethnicity.value =
                    fromDictionary("translateEthnicity", data.details.ethnicity.value);
            }

            if (data.details?.creature?.value) {
                data.details.creature.value =
                    fromDictionary("translateFamiliarType", data.details.creature.value);
            }

            if (data.details?.gender?.value) {
                data.details.gender.value =
                    fromDictionary("translateGender", data.details.gender.value);
            }

            if (data.attributes?.hp?.details) {
                data.attributes.hp.details =
                    fromDictionary("translateHpDetails", data.attributes.hp.details);
            }

            if (data.attributes?.speed?.details) {
                data.attributes.speed.details =
                    fromDictionary("translateSpeedDetails", data.attributes.speed.details);
            }

            if (dataObject.type === "npc" && data.details?.source?.value) {
                data.details.source.value =
                    fromDictionary("translateSource", data.details.source.value);
            } else if (dataObject.type === "hazard" && data.source?.value) {
                data.source.value = fromDictionary("translateSource", data.source.value);
            }

            if (data.traits?.di?.custom) {
                data.traits.di.custom = fromDictionary("translateImmunity", data.traits.di.custom);
            }

            if (data.traits?.languages?.custom) {
                data.traits.languages.custom =
                    fromDictionary("translateLanguage", data.traits.languages.custom);
            }

            if (data.traits?.senses?.value) {
                data.traits.senses.value =
                    fromDictionary("translateSense", data.traits.senses.value);
            }

            if (data.traits?.traits?.custom) {
                data.traits.traits.custom =
                    fromDictionary("translateTrait", data.traits.traits.custom);
            }

            setTranslatedText(data, "details.reset", translations.reset);
            setTranslatedText(data, "details.routine", translations.routine);
            setTranslatedText(data, "details.disable", translations.disable);
            setTranslatedText(data, "attributes.stealth.details", translations.stealth);

            // Translate exceptions to damage resistance
            if (data.traits?.dr) {
                data.traits.dr.forEach((element, index, array) => {
                    if (array[index].hasOwnProperty("exceptions") && array[index].exceptions !== "") {
                        array[index].exceptions = fromDictionary("translateResistanceException", element.exceptions);
                    }
                });
            }

            // Create a formatted npc description based on the data provided in the json and based on the actor type
            if (isTranslationObject(translations.description)) {
                if (dataObject.type === "npc") {
                    let npcData = translations.description;

                    // If a npc description is available create npc name and npc description
                    // Use NPCName provided within the description or use the translated name of the npc as default
                    let npcDesc = "";
                    if (npcData.NPCDescription) {
                        npcDesc = `<h2>${npcData.NPCName ?? translationObject.name ?? ""}</h2>\n`;
                        npcDesc = npcDesc.concat(`${npcData.NPCDescription}\n`);
                    }

                    // Create creature family name
                    if (npcData.FamilyName) {
                        npcDesc = npcDesc.concat(`<p>&nbsp;</p>\n<h2>${npcData.FamilyName}</h2>\n`);

                        // If family name exists, create creature family description
                        if (npcData.FamilyDescription) npcDesc = npcDesc.concat(`${npcData.FamilyDescription}\n`);
                    }

                    // Create additional infos
                    if (npcData.AdditionalInfo) {
                        npcDesc = npcDesc.concat(`<p>&nbsp;</p>\n<table border="0">\n<tbody>\n`);

                        for (const [infoTypeNumbered, infos] of Object.entries(npcData.AdditionalInfo)) {
                            const infoType = infoTypeNumbered.slice(0, infoTypeNumbered.length - 1);
                            if (["item", "lore", "location", "monster", "rule", "treasure"].includes(infoType)) {
                                const img = `<img src="modules/pf2e_compendium_chn/npc/icons/${infoType}.webp" alt="" width="40" height="40" />`;

                                for (const [infoName, infoText] of Object.entries(infos)) {
                                    npcDesc = npcDesc
                                        .concat(`<tr>\n<td style="width: 45px" valign= "top">${img}</td>\n`)
                                        .concat(`<td><h3>${infoName}</h3>\n${infoText}\n</td>\n</tr>\n`);
                                }
                            }
                        }

                        npcDesc = npcDesc.concat(`</tbody>\n</table>\n`);
                    }

                    if (npcDesc.length) setTranslatedText(data, "details.publicNotes", npcDesc);
                } else if (dataObject.type === "hazard") {
                    setTranslatedText(data, "details.description", translations.description.NPCDescription);
                } else if (dataObject.type === "character") {
                    setTranslatedText(data, "details.biography.appearance", translations.description.NPCDescription);
                }
            }
        }

        const mapping = resolveActiveMapping(translatedCompendium?.mapping?.mapping ?? {}, dataObject);
        applyFlatActorText(data, translationObject, original, mapping);
        // A directly mapped translation owns its destination regardless of
        // field ordering. The legacy whole-system payload must not overwrite it.
        for (const [field, definition] of Object.entries(mapping)) {
            if (field === "data") continue;
            const path = mappingPath(definition, dataObject);
            if (!path?.startsWith("system.")) continue;
            const relative = path.slice(7);
            const originalValue = foundry.utils.getProperty(original, relative);
            const aliases = (definition?.aliases ?? []).filter((key) => !Object.hasOwn(mapping, key));
            const candidates = [translationObject[field], ...aliases.map((key) => translationObject[key])];
            if (candidates.some((value) => typeof value === "string" && value !== originalValue)) {
                setTranslatedText(data, relative, originalValue);
            }
        }
        return data;
    }

    // Translate the various items within actor.data.items
    //  - This uses the available translations for spells and equipment from the DE module.
    //  - For abilities and strikes it uses the translations from the json first and available standard translations second
    //  - The labels for skill variants can be translated using an automatic dictionary-based translation
    //  - Spellcasting entries are translated using an automated dictionary-based translation

    item(data, translations, dataObject, translatedCompendium, translationObject, runtime = {}, params = {}) {
        if (!Array.isArray(data) || data.length === 0) return data;
        const originals = data;
        data = foundry.utils.deepClone(data);
        // Array translation files are a compatibility format. Index them once
        // instead of rescanning the whole list for each imported item.
        if (Array.isArray(translations)) {
            translations = Object.fromEntries(translations.filter((entry) => entry?.id != null)
                .map((entry) => [entry.id, entry]));
        }
        const explicitEntries = {};
        const hasExplicit = data.map((entry) => {
            if (!isTranslationObject(entry) || typeof entry.name !== "string" || !isTranslationObject(entry.system)) return false;
            const originalNames = [...new Set([
                entry.originalName, entry.flags?.babele?.originalName, entry.name,
            ].filter((name) => typeof name === "string"))];
            const equipment = ["armor", "weapon", "equipment", "consumable", "treasure", "backpack"].includes(entry.type);
            const prefix = entry.type === "melee" ? "strike-" : equipment ? "equipment-" : "";
            const names = prefix ? [...originalNames.map((name) => `${prefix}${name}`), ...originalNames] : originalNames;
            const explicit = findItemTranslation(translations, entry, names);
            if (!isTranslationObject(explicit) && typeof explicit !== "string") return false;
            explicitEntries[entry._id ?? entry.name] = typeof explicit === "string" ? { name: explicit } : explicit;
            return true;
        });
        // Reuse the current pack's mapping aggregate: outside a native session
        // reading game.babele.documentMappings rebuilds all registered layers.
        const documentMappings = hasExplicit.some(Boolean)
            ? translatedCompendium?.documentMappings ?? game.babele.documentMappings : null;
        const mapping = localItemMapping(translatedCompendium, params);
        const explicitPack = documentMappings ? new EmbeddedCompendium("Item", {
            mapping, translations: explicitEntries, documentMappings, runtime,
        }) : null;
        const originalEntries = Object.fromEntries(data.filter((entry, index) => hasExplicit[index]
            && isTranslationObject(entry.flags?.babele?.originalPayload))
            .map((entry) => [entry._id ?? entry.name, entry.flags.babele.originalPayload]));
        const originalPack = Object.keys(originalEntries).length ? new EmbeddedCompendium("Item", {
            mapping, translations: originalEntries, documentMappings, runtime,
        }) : null;
        const explicitResults = data.map((entry, index) => {
            if (!hasExplicit[index]) return null;
            const hasOriginal = isTranslationObject(entry.flags?.babele?.originalPayload);
            let source = translationInput(entry, hasOriginal);
            if (hasOriginal) {
                // Recreate the original-language baseline through the native
                // Item lifecycle. Nested effects may be keyed by original name.
                source = foundry.utils.mergeObject(source, originalPack.translate(source, true, runtime), { inplace: false });
                source = translationInput(source);
            }
            const payload = explicitPack.translate(source, true, runtime);
            return { source, translated: foundry.utils.mergeObject(source, payload, { inplace: false }) };
        });
        data.forEach((entry, index, arr) => {
            if (!isTranslationObject(entry) || typeof entry.name !== "string" || !isTranslationObject(entry.system)) return;
            if (!this.dict.translations || entry.translated === true) return;
            if (dataObject?.type === "vehicle" && !hasExplicit[index]) return;
            if (entry.type === "spell") {
                let spellOffset;
                const offsetStart = entry.name.indexOf("(");
                if (offsetStart !== -1) {
                    spellOffset = this.dict.translateSpellOffset(entry.name.slice(offsetStart));
                    entry.name = entry.name.slice(0, offsetStart).trimEnd();
                }
                const translated = this.dict.compendiumTranslation(entry, "pf2e.spells-srd");
                if (spellOffset != null) translated.name = translated.name.concat(" ", spellOffset);
                arr[index] = translated;
            } else if (["armor", "weapon", "equipment", "consumable", "treasure", "backpack"].includes(entry.type)) {
                arr[index] = this.dict.translateItem(entry, this.sluggify(entry.name));
            } else if (["npc", "hazard"].includes(dataObject?.type) && ["action", "melee", "effect"].includes(entry.type)) {
                const slug = this.sluggify(entry.name);
                const strike = this.dict.translateStrike(entry.name);
                if (strike === entry.name) arr[index] = this.dict.compendiumTranslation(entry, "pf2e.bestiary-ability-glossary-srd");
                else arr[index].name = strike;
                if (!arr[index].system.slug) arr[index].system.slug = slug;
            } else if (entry.type === "condition") {
                arr[index] = this.dict.compendiumTranslation(entry, "pf2e.conditionitems");
            } else if (["character", "familiar"].includes(dataObject?.type)) {
                if (entry.type === "feat") {
                    const originalDescription = entry.system.description?.value;
                    for (const pack of ["pf2e.feats-srd", "pf2e.classfeatures", "pf2e.ancestryfeatures"]) {
                        const candidate = this.dict.compendiumTranslation(entry, pack);
                        arr[index] = overlayTranslation(arr[index], entry, candidate, true);
                        if (arr[index].system.description?.value !== originalDescription) break;
                    }
                } else {
                    const pack = { action: "pf2e.actionspf2e", ancestry: "pf2e.ancestries", heritage: "pf2e.heritages",
                        class: "pf2e.classes", background: "pf2e.backgrounds", deity: "pf2e.deities" }[entry.type];
                    if (pack) arr[index] = this.dict.compendiumTranslation(entry, pack);
                }
            }
            if (entry.type === "lore") {
                arr[index].name = this.dict.translateLore(entry.name);
                if (isTranslationObject(entry.system.variants) || Array.isArray(entry.system.variants)) {
                    for (const variant of Object.values(entry.system.variants)) {
                        if (isTranslationObject(variant) && typeof variant.label === "string") {
                            variant.label = this.dict.translateSkillVariant(variant.label);
                        }
                    }
                }
            } else if (entry.type === "spellcastingEntry") {
                arr[index].name = this.dict.translateSpellcasting(entry.name);
            }
        });
        for (const [index, explicit] of explicitResults.entries()) {
            if (!explicit || sameValue(explicit.source, explicit.translated)) continue;
            const combined = overlayTranslation(data[index], explicit.source, explicit.translated);
            const previousFlags = originals[index].flags?.babele;
            const originalPayload = previousFlags?.originalPayload ?? explicitPack.extract(explicit.source, runtime);
            data[index] = new DocumentTranslation({
                source: originals[index], payload: combined, hasTranslation: true, originalPayload,
                language: previousFlags?.lang ?? translatedCompendium?.language ?? null,
            }).apply();
            const originalName = originals[index].originalName ?? previousFlags?.originalName;
            if (typeof originalName === "string") {
                data[index].originalName = originalName;
                data[index].flags.babele.originalName = originalName;
            }
        }
        return data;
    }

}

// Dictionary class that handles translations
class Dictionary {
    async loadTranslations(url) {
        try {
            const response = await fetch(url);
            if (response.ok === false) throw new Error(`Dictionary request failed: ${response.status}`);
            const translations = await response.json();
            if (!isTranslationObject(translations)) throw new Error("Invalid NPC dictionary");
            this.translations = translations;
            return translations;
        } catch (error) {
            this.translations = undefined;
            console.warn("pf2e_compendium_chn: NPC dictionary unavailable; preserving untranslated item data", error);
            return undefined;
        }
    }

    constructor() {
        this.ready = this.loadTranslations("modules/pf2e_compendium_chn/npc/NPCDictionary.json");

    }

    dictionaryTranslate(strings, translations) {
        if (!isTranslationObject(translations)) return strings;
        const translate = (entry) => {
            if (typeof entry !== "string") return entry;
            const key = entry.toLowerCase().trim();
            return Object.hasOwn(translations, key) ? translations[key] : entry;
        };
        if (Array.isArray(strings)) {
            return strings.map(translate);
        }
        return translate(strings);
    }

    dictionaryReplace(str, translations) {
        if (!isTranslationObject(translations)) return str;
        if (typeof str === "string") {
            let transl = str.toLowerCase();
            for (const [key] of Object.entries(translations)) {
                transl = transl.replaceAll(key, translations[key]);
            }
            if (transl === str.toLowerCase()) return str;
            return transl;
        }

        return str;
    }

    translateSimpleList(str, translations) {
        if (typeof str !== "string") return str;
        // Try translation for the whole string in case it is a single entry containing commas
        let fullTranslation = this.dictionaryTranslate(str, translations);
        if (fullTranslation !== str) return fullTranslation;

        // Split the various entries, translate each one on its own
        return this.dictionaryTranslate(str.split(","), translations).sort().join(", ");
    }

    translateComplexList(str, translations) {
        if (typeof str !== "string" || !isTranslationObject(translations)) return str;
        const semicolonSeparation = str.split(";");
        semicolonSeparation.forEach((value, key, array) => {
            const commaSeparation = value.split(",");
            commaSeparation.forEach((value, key, array) => {
                const rgx = new RegExp("(?:(\\d+)?([^\\d\\(]+)(\\d+)?|^)(?:(?:| |^)\\(([^\\)]+)\\))?", "g");
                array[key] = value.trim().replace(rgx, (match, p1, p2, p3, p4) => {
                    p2 ? (p2 = this.dictionaryTranslate(p2.trim(), translations)) : undefined;
                    p4 ? (p4 = this.translateComplexList(p4.trim(), translations)) : undefined;

                    match = "";
                    if (p1 && p3) match = match.concat(p1);
                    if (p2) match = match.concat(" ", p2);
                    if (p1 && !p3) match = match.concat(" ", p1);
                    if (p3) match = match.concat(" ", p3);
                    if (p4) match = match.concat(" (", p4, ")");

                    return match.trim();
                });
            });
            array[key] = commaSeparation.sort().join(", ");
        });
        return semicolonSeparation.join("; ");
    }

    compendiumTranslation(data, compendium) {
        if (!isTranslationObject(data) || typeof data.name !== "string") return data;
        data = foundry.utils.deepClone(data);
        // Special treatment for standard abilities with modified names (excluding spells)
        let translatedName = "";

        if (["action", "effect", "melee"].includes(data.type)) {
            // Fast Healing
            if (data.name.search(RegExp(`(Fast Healing)`, "g")) > -1) {
                const rgx = new RegExp("Fast Healing ?(\\d+)?(?: \\(([^\\)]+)\\))?", "g");
                translatedName = data.name.replace(rgx, (match, value, restriction) => {
                    match = "快速治疗";
                    if (value) match = match.concat(` ${value}`);
                    if (restriction)
                        match = match.concat(` (${this.translateFastHealingRestriction(restriction.toLowerCase())})`);
                    return match;
                });
                data.name = "Fast Healing";

                // Push
            } else if (data.name.search(RegExp(`(Push|Improved Push)`, "g")) > -1) {
                const rgx = new RegExp("^([^\\d]+)(\\d+ feet)?", "g");
                translatedName = data.name.replace(rgx, (match, type, range) => {
                    match = this.dictionaryTranslate(type.trim().toLowerCase(), this.translations.PushVariants);
                    if (range) {
                        match = match.concat(` ${this.translateRange(range)}`);
                    }
                    return match;
                });

                // Regeneration
            } else if (data.name.search(RegExp(`(Regeneration)`, "g")) > -1) {
                const rgx = new RegExp("Regeneration ?(\\d+)?(?: \\(([^\\)]+)\\))?", "g");
                translatedName = data.name.replace(rgx, (match, value, deactivation) => {
                    match = "再生";
                    if (value) match = match.concat(` ${value}`);
                    if (deactivation)
                        match = match.concat(` (${this.translateRegenerationDeactivate(deactivation.toLowerCase())})`);
                    return match;
                });
                data.name = "Regeneration";

                // Save bonuses
            } else if (data.name.search(RegExp(`\\+\\d `, "g")) > -1) {
                translatedName = this.dictionaryReplace(
                    data.name.toLowerCase().replace(" vs ", " vs. "),
                    this.translations.SaveDetails
                );

                // Senses
            } else if (data.name.search(RegExp(`(Lifesense|Scent|Thoughtsense|Tremorsense|Wavesense)`, "g")) > -1) {
                translatedName = this.translateSense(data.name.toLowerCase());
                data.name = data.name.split(" ", 1)[0];

                // Telepathy
            } else if (data.name.search(RegExp(`(Telepathy)`, "g")) > -1) {
                translatedName = this.translateLanguage(data.name);
                data.name = data.name.split(" ", 1)[0];
            }
        }

        // Babele 2.8.0 dropped `babele.packs` in favor of the public translate(pack, data) facade.
        const lookupName = data.name;
        let translation = game.babele.translate(compendium, data) ?? data;
        if (typeof translation.name !== "string") translation = data;
        if (translation.name !== lookupName && translation.name.search("/") != -1)
            translation.name = translation.name.substring(0, translation.name.search("/"));

        if (translatedName != "") {
            translation.name = translatedName;
        }

        return translation;
    }

    translateAcDetails(str) {
        return this.translateComplexList(str, this.translations.AcDetails);
    }

    translateFastHealingRestriction(str) {
        return this.dictionaryTranslate(str, this.translations.FastHealingRestriction);
    }

    translateFamiliarType(str) {
        return this.dictionaryTranslate(str, this.translations.FamiliarType);
    }

    translateEthnicity(str) {
        return this.dictionaryTranslate(str, this.translations.Ethnicity);
    }

    translateGender(str) {
        return this.dictionaryTranslate(str, this.translations.Gender);
    }

    translateHpDetails(str) {
        str = this.translateComplexList(str, this.translations.RegenerationDeactivate);
        str = this.translateComplexList(str, this.translations.FastHealingRestriction);
        return this.translateComplexList(str, this.translations.HpDetails);
    }

    translateImmunity(str) {
        return this.translateSimpleList(str, this.translations.Immunity);
    }

    translateItem(item, slug) {
        if (!isTranslationObject(item) || typeof item.name !== "string" || !isTranslationObject(item.system)) return item;
        let translatedItem = item;

        if (!this.translations || item.translated === true) return item;
            // Translate non-compendium items and items with altered names
        if (Object.hasOwn(this.translations.Item ?? {}, item.name.toLowerCase())) {
            const translation = this.translations.Item[item.name.toLowerCase()];
            if (translation.baseItem) {
                item.name = translation.baseItem;
                translatedItem = this.compendiumTranslation(item, "pf2e.equipment-srd");
            }
            translatedItem.name = translation.name;
            if (translation.description && isTranslationObject(translatedItem.system.description)) {
                translatedItem.system.description.value = translation.description;
            }
            if (typeof translatedItem.system.publication?.title === "string") {
                translatedItem.system.publication.title = this.translateSimpleList(
                    translatedItem.system.publication.title, this.translations.Source
                );
            }

            // Translate magic weapons using a dictionary
        } else if (item.type === "weapon" && !item.system.specific) {
            const weapons = this.translations.MagicWeapons;
            const runes = item.system.runes;
            const gender = weapons?.BaseItemGender?.[item.system.baseItem];
            const materialData = weapons?.Materials?.[item.system.material?.type];
            const propertyIds = runes?.property;
            const properties = Array.isArray(propertyIds) ? propertyIds.map((id) => weapons?.PropertyRunes?.[id]) : [];
            // Custom/new PF2e modifiers may not be in this optional dictionary.
            // Preserve the supplied name instead of dropping a modifier or throwing.
            const unsupported = !weapons || !runes || !Array.isArray(propertyIds)
                || (runes.striking && typeof weapons.StrikingRunes?.[runes.striking] !== "string")
                || (item.system.material?.type && typeof materialData?.[gender] !== "string")
                || properties.some((property) => typeof property?.[gender] !== "string");
            if (unsupported) {
                translatedItem = this.compendiumTranslation(item, "pf2e.equipment-srd");
                if (!translatedItem.system.slug) translatedItem.system.slug = slug;
                return translatedItem;
            }
            // Get base item gender
            const baseItemGender = gender;

            // Get property rune
            const propertyRune = item.system.runes.potency ? `+${item.system.runes.potency} ` : "";

            // Get striking rune
            const striking = item.system.runes.striking
                ? ` ${this.translations.MagicWeapons.StrikingRunes[item.system.runes.striking]}`
                : "";

            // Get material
            const materialOrder = item.system.material?.type
                ? materialData.order
                : "";
            const material = item.system.material?.type
                ? materialData[baseItemGender]
                : "";

            // Get property runes
            const propertyRunes = properties;

            // Get sorted and gendered property runes split by suffix/prefix
            const prefixRunes = [];
            const suffixRunes = [];
            propertyRunes.forEach((element) => {
                if (element.order === "prefix") prefixRunes.push(`${element[baseItemGender]} `);
                if (element.order === "suffix") suffixRunes.push(` ${element[baseItemGender]}`);
            });

            // Translate base item
            translatedItem = this.compendiumTranslation(item, "pf2e.equipment-srd");

            // Only rebuild a name when the source name was a canonical base
            // weapon and a translation was found. Already decorated/custom
            // names must not receive a second copy of their rune prefixes.
            const baseSlug = typeof item.system.baseItem === "string" ? item.system.baseItem : "";
            const sourceSlug = item.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
            if (!baseSlug || sourceSlug !== baseSlug || translatedItem.name === item.name) {
                if (!translatedItem.system.slug) translatedItem.system.slug = slug;
                return translatedItem;
            }
            if (materialOrder === "prefix") {
                translatedItem.name = material.concat(" ").concat(translatedItem.name);
            } else if (materialOrder === "suffix") {
                translatedItem.name = translatedItem.name.concat(" ").concat(material);
            }

            translatedItem.name = [propertyRune.trim(), striking.trim(), ...prefixRunes.sort().map((value) => value.trim()),
                translatedItem.name, ...suffixRunes.sort().map((value) => value.trim())].filter(Boolean).join(" ");

            // Standard compendium translation
        } else {
            translatedItem = this.compendiumTranslation(item, "pf2e.equipment-srd");
        }
        if (!translatedItem.system.slug) translatedItem.system.slug = slug;
        return translatedItem;
    }

    translateLanguage(str) {
        if (typeof str !== "string") return str;
        const rgx = new RegExp("^([^\\d]+)(\\d+ (?:feet|miles|mile))?([\\s\\S]+)?", "g");
        const commaSeparation = str.split(",");
        commaSeparation.forEach((value, key, array) => {
            array[key] = value.replace(rgx, (match, type, range, suffix) => {
                match = this.dictionaryTranslate(type.trim().toLowerCase(), this.translations.Language);
                if (range) {
                    match = match.concat(` ${this.translateRange(range)}`);
                }
                if (suffix) {
                    match = match.concat(
                        ` ${this.dictionaryTranslate(suffix.trim().toLowerCase(), this.translations.Language)}`
                    );
                }
                return match;
            });
        });
        return commaSeparation.sort().join(", ");
    }

    translateLore(str) {
        return this.dictionaryTranslate(str, this.translations.Lore);
    }

    translateRange(str) {
        if (typeof str !== "string") return str;
        if (Object.hasOwn(this.translations.Range ?? {}, str))
            return this.dictionaryTranslate(str, this.translations.Range);

        let value = parseInt(str);
        if (value) {
            if (str.search(/mile/g) > -1) return `${value} 英里`;
            else if (str.search(/miles/g) > -1) return `${value} 英里`;
            else if (str.search(/feet/g) > -1) return `${value} 尺`;
            else return str;
        } else return str;
    }

    translateRegenerationDeactivate(str) {
        return this.dictionaryTranslate(str, this.translations.RegenerationDeactivate);
    }

    translateResistanceException(str) {
        if (typeof str !== "string") return str;
        return this.dictionaryTranslate(str.replace(/except /g, ""), this.translations.ResistanceException);
    }

    translateSave(str) {
        return this.translateSimpleList(str, this.translations.SaveDetails);
    }

    translateSense(str) {
        if (typeof str !== "string") return str;
        const semicolonSeparation = str.split(";");
        semicolonSeparation.forEach((value, key, array) => {
            const commaSeparation = value.split(",");
            commaSeparation.forEach((value, key, array) => {
                // Translate perception details, e.g. (+27 to detect lies)
                const rgxPerc = new RegExp("\\((\\+\\d+)([^)]+)\\)", "g");
                if (value.search(rgxPerc) > -1) {
                    array[key] = value.replace(rgxPerc, (match, bonus, type) => {
                        return `(${this.dictionaryTranslate(
                            type.trim(),
                            this.translations.PerceptionDetails
                        )} ${bonus})`;
                    });
                } else {
                    // Translate senses
                    const rgxSense = new RegExp(
                        "^([^\\d\\(]+)(?:\\(([^\\)]+)\\))? ?(\\d+ feet)? ?(?:([^\\(]+))? ?(?:\\(([^\\)]+)\\))?",
                        "g"
                    );
                    array[key] = value.trim().replace(rgxSense, (match, type, acuity, range, textRange, senseRestriction) => {
                        type = this.dictionaryTranslate(type.trim(), this.translations.Sense);
                        acuity = this.translateSensePrecision(acuity);
                        range = this.translateRange(range);
                        textRange = this.translateRange(textRange);
                        senseRestriction = this.translateSenseRestriction(senseRestriction);
                        match = type;
                        if (acuity) match = match.concat(` (${acuity})`);
                        if (range) match = match.concat(` ${range}`);
                        if (textRange) match = match.concat(` ${textRange}`);
                        if (senseRestriction) match = match.concat(` (${senseRestriction})`);
                        return match;
                    });
                }
            });
            array[key] = commaSeparation.sort().join(", ");
        });
        return semicolonSeparation.join("; ");
    }

    translateSensePrecision(str) {
        return this.dictionaryTranslate(str, this.translations.SensePrecision);
    }

    translateSenseRestriction(str) {
        return this.dictionaryTranslate(str, this.translations.SenseRestriction);
    }

    translateSkillVariant(str) {
        if (typeof str === "string") {
            const rgx = new RegExp(`(\\+\\d+)?([\\s\\S]+)$`, "g");
            return str.toLowerCase().replace(rgx, (match, p1, p2) => {
                match = `${this.dictionaryTranslate(p2.trim(), this.translations.SkillVariant)}`;
                if (p1) {
                    match = match.concat(` ${p1}`);
                }
                return match;
            });
        }
        return "";
    }

    translateSource(str) {
        return this.dictionaryTranslate(str, this.translations.Source);
    }

    translateSpellcasting(str) {
        return this.dictionaryTranslate(str, this.translations.Spellcasting);
    }

    translateSpellOffset(str) {
        if (typeof str !== "string") return str;
        if (str.search(/\) \(/g) > -1)
            return `(${this.dictionaryTranslate(
                str
                    .replace(/\) \(/g, "|")
                    .replace(/[\(\)]/g, "")
                    .split("|"),
                this.translations.SpellOffset
            ).join(") (")})`;
        return `(${this.dictionaryTranslate(str.replace(/[\(\)]/g, ""), this.translations.SpellOffset)})`;
    }

    translateStrike(str) {
        return this.dictionaryTranslate(str, this.translations.Strike);
    }

    translateSpeedDetails(str) {
        //return this.translateSimpleList(str, this.translations.SpeedDetails);
        return this.translateComplexList(str, this.translations.SpeedDetails);
    }

    translateTrait(str) {
        return this.translateSimpleList(str, this.translations.Trait);
    }
}
