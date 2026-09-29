// Shared PF2e translation schema. Compendium-local mapping entries override
// these defaults through Babele's normal mapping merge.
// Based on AlphaStarguide/pf2e_compendium_chn; GPL-3.0, see LICENSE.

const text = (path, aliases = []) => ({ path, converter: "pf2e-actor-text", aliases });
const systemText = (paths, aliases = []) => ({
    path: "system", converter: "pf2e-actor-system-text", paths, aliases,
});

function matchesMappingCondition(condition, source) {
    if (!condition) return false;
    if (Array.isArray(condition.all)) return condition.all.every((entry) => matchesMappingCondition(entry, source));
    if (Array.isArray(condition.any)) return condition.any.some((entry) => matchesMappingCondition(entry, source));
    if (typeof condition.path !== "string" || condition.path.length === 0) return false;
    const value = foundry.utils.getProperty(source, condition.path);
    const checks = [];
    if (Object.hasOwn(condition, "equals")) checks.push(value === condition.equals);
    if (Array.isArray(condition.in)) checks.push(condition.in.includes(value));
    if (Object.hasOwn(condition, "exists")) checks.push((value !== undefined) === Boolean(condition.exists));
    return checks.length > 0 && checks.every(Boolean);
}

// Mirror Babele 2.9's source-aware field selection. Looking only at base keys
// misses aliases redirected by a matching _variants/legacy subtype mapping.
export function resolveActiveMapping(mapping = {}, source = {}) {
    const { _variants, _identity, ...base } = mapping ?? {};
    const fields = new Map(Object.entries(base));
    for (const variant of Array.isArray(_variants) ? _variants : []) {
        const { _when, ...entries } = variant ?? {};
        if (!matchesMappingCondition(_when, source)) continue;
        for (const [key, value] of Object.entries(entries)) {
            fields.delete(key);
            fields.set(key, value);
        }
    }
    return Object.fromEntries(fields);
}

export function createDefaultMappings() {
    return {
        Actor: {
            name: "name",
            // Retain legacy nested translations; the converter checks field
            // ownership instead of relying on merged mapping iteration order.
            // Do not use _variants here: a default variant would take priority
            // over a compendium's ordinary same-key override in Babele 2.9.
            data: { path: "system", converter: "npc-data-translation" },
            description: systemText({
                npc: "details.publicNotes",
                hazard: "details.description",
                vehicle: "details.description",
                character: "details.biography.appearance",
            }),
            publicNotes: text("system.details.publicNotes"),
            privateNotes: text("system.details.privateNotes"),
            blurb: text("system.details.blurb"),
            ac: text("system.attributes.ac.details"),
            hp: text("system.attributes.hp.details"),
            allSaves: text("system.attributes.allSaves.value"),
            speed: systemText({ vehicle: "details.speed", default: "attributes.speed.details" }),
            languages: text("system.traits.languages.custom"),
            senses: text("system.traits.senses.value"),
            di: text("system.traits.di.custom"),
            hazarddescription: text("system.details.description"),
            disable: text("system.details.disable", ["hazarddisable"]),
            routine: text("system.details.routine", ["hazardroutine"]),
            reset: text("system.details.reset", ["hazardreset"]),
            stealthdetails: text("system.attributes.stealth.details"),
            appearance: text("system.details.biography.appearance"),
            backstory: text("system.details.biography.backstory"),
            campaignNotes: text("system.details.biography.campaignNotes"),
            gender: text("system.details.gender.value"),
            ethnicity: text("system.details.ethnicity.value"),
            nationality: text("system.details.nationality.value"),
            crew: text("system.details.crew"),
            pilotingCheck: text("system.details.pilotingCheck"),
            portrait: { path: "img", converter: "npc-portrait-path" },
            token: { path: "prototypeToken", converter: "npc-token-translation" },
            items: { path: "items", converter: "npc-item-translation" },
        },
        Item: {
            name: "name",
            description: "system.description.value",
            gmnote: "system.description.gm",
            attackEffectsCustom: "system.attackEffects.custom",
            prerequisites: {
                path: "system.prerequisites.value",
                converter: "structured",
                cardinality: "many",
                mapping: { value: "value" },
            },
            cost: "system.cost.value",
            duration: "system.duration.value",
            target: "system.target.value",
            primarycheck: "system.primarycheck.value",
            secondarycasters: "system.secondarycasters.value",
            secondarycheck: "system.secondarycheck.value",
        },
    };
}

function translatedText(original, translation, allTranslations, aliases = [], compendium, source) {
    if (typeof original !== "string") return undefined;
    // Legacy hazard-prefixed aliases can carry the actual Chinese translation
    // while a newer export leaves the unprefixed field in English.
    // If a file explicitly maps an alias, that mapping owns its destination.
    // An alias redirected elsewhere must not also write this default path.
    const mapping = aliases.length ? resolveActiveMapping(compendium?.mapping?.mapping, source) : {};
    const candidates = [...aliases.filter((key) => !Object.hasOwn(mapping, key))
        .map((key) => allTranslations?.[key]), translation];
    return candidates.find((value) => typeof value === "string" && value !== original);
}

function systemTextPath(source, params) {
    return params.paths?.[source?.type] ?? params.paths?.default;
}

export function createDefaultConverters() {
    return {
        "pf2e-actor-text": {
            translate({ value, translation, allTranslations, source, params, contextCompendium }) {
                return translatedText(value, translation, allTranslations, params.aliases, contextCompendium, source);
            },
            extract({ value }) {
                return typeof value === "string" ? value : undefined;
            },
        },
        "pf2e-actor-system-text": {
            translate({ value, translation, allTranslations, source, params, contextCompendium }) {
                const path = systemTextPath(source, params);
                if (!path) return undefined;
                const translated = translatedText(foundry.utils.getProperty(value, path), translation, allTranslations, params.aliases, contextCompendium, source);
                if (translated === undefined) return undefined;
                const changes = {};
                foundry.utils.setProperty(changes, path, translated);
                return changes;
            },
            extract({ value, source, params }) {
                const path = systemTextPath(source, params);
                const original = path ? foundry.utils.getProperty(value, path) : undefined;
                return typeof original === "string" ? original : undefined;
            },
        },
    };
}
