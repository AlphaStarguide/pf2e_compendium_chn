import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const url = new URL("../babele-ondemand-patch.js", import.meta.url);
// Evaluate the complete source in a fresh Foundry-like environment. Only import.meta
// is substituted because vm.Script does not have an ES module URL.
const source = readFileSync(url, "utf8").replaceAll("import.meta.url", JSON.stringify(url.href));

function deferred() {
	let resolve;
	const promise = new Promise((r) => { resolve = r; });
	return { promise, resolve };
}

function harness() {
	const timers = new Map();
	const wrappers = new Map();
	let timerId = 0;
	let mode = "ondemand";
	const state = { titleIndex: { "example.items": { titles: { a: "烈焰 长剑", b: "寒霜 法杖" } } } };
	const pack = { collection: "example.items", index: new Map() };
	const document = (id, name) => ({ id, name, pack: pack.collection, uuid: `Compendium.example.items.Item.${id}` });
	const docs = { a: document("a", "Old Sword"), b: document("b", "Old Staff") };
	const world = { uuid: "Item.world", name: "World Treasure" };
	const untouched = { uuid: "Compendium.other.items.Item.shield", name: "Other Shield" };
	for (const doc of Object.values(docs)) pack.index.set(doc.id, { ...doc, _id: doc.id });
	const game = {
		packs: new Map([[pack.collection, pack]]),
		modules: new Map([["lib-wrapper", { active: true }]]),
		settings: { get: () => mode },
		babele: { __ondemandPatch: state },
	};
	const counts = { full: 0, replace: 0, remove: 0, wrapped: 0 };
	// Small test double for the public DocumentIndex contract. It intentionally
	// appends on index(), like Foundry: the patch owns clearing before a rebuild.
	const index = {
		trees: {}, uuids: {}, ready: null,
		add(entry) {
			const leaf = { uuid: entry.uuid, name: entry.name };
			(this.trees.Item ??= []).push(leaf);
			this.uuids[entry.uuid] = leaf;
		},
		async index() {
			await this.ready;
			counts.full++;
			this.ready = Promise.resolve();
			for (const entry of [...pack.index.values(), world, untouched]) this.add(entry);
			await this.afterBuild?.();
		},
		removeDocument(doc) {
			counts.remove++;
			const leaves = this.trees.Item ?? [];
			for (let i = leaves.length - 1; i >= 0; i--) if (leaves[i].uuid === doc.uuid) leaves.splice(i, 1);
			delete this.uuids[doc.uuid];
		},
		replaceDocument(doc) {
			counts.replace++;
			this.removeDocument(doc);
			const entry = game.packs.get(doc.pack)?.index.get(doc.id);
			if (entry) this.add(entry);
		},
	};
	game.documentIndex = index;
	for (const entry of [...pack.index.values(), world, untouched]) index.add(entry);
	const mergeObject = (target, update) => {
		for (const [key, value] of Object.entries(update)) {
			if (value && typeof value === "object" && !Array.isArray(value)) mergeObject(target[key] ??= {}, value);
			else target[key] = value;
		}
		return target;
	};
	const context = vm.createContext({
		game, URL, Dialog: class {}, foundry: { utils: { mergeObject } },
		Hooks: { on() {}, once() {} }, console: { info() {} },
		libWrapper: { register(_id, path, callback) { wrappers.set(path, callback); } },
		setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
		clearTimeout(id) { timers.delete(id); },
	});
	vm.runInContext(source, context, { filename: url.pathname });
	context.registerWrappers();
	const wrapper = wrappers.get("foundry.documents.collections.CompendiumCollection.prototype.indexDocument");
	const result = { unchanged: true };
	const update = (doc) => wrapper.call(pack, (incoming) => {
		counts.wrapped++;
		// Represents the entry produced by the wrapped core/Babele chain; metadata
		// and Babele flags must survive this patch's subsequent title translation.
		pack.index.set(incoming.id, { ...incoming, _id: incoming.id });
		return result;
	}, doc);
	const takeTimer = () => {
		const next = timers.entries().next().value;
		assert.ok(next, "a flush is scheduled");
		timers.delete(next[0]);
		return next[1]();
	};
	const flush = async () => {
		for (let count = 0; timers.size; count++) {
			assert.ok(count < 10, "queue settles without an infinite fallback loop");
			await takeTimer();
		}
	};
	const search = (name) => (index.trees.Item ?? []).filter((leaf) => leaf.name.includes(name)).map((leaf) => leaf.uuid);
	return { state, pack, docs, game, index, context, counts, update, result, takeTimer, flush, timers, search, setMode: (value) => { mode = value; } };
}

test("a translated entry replaces old search words without rebuilding unrelated entries", async () => {
	const h = harness();
	const tree = h.index.trees.Item;
	assert.equal(h.update(h.docs.a), h.result);
	await h.flush();
	assert.deepEqual(h.search("Old Sword"), []);
	assert.deepEqual(h.search("烈焰"), [h.docs.a.uuid]);
	assert.deepEqual(h.search("World"), ["Item.world"]);
	assert.deepEqual(h.search("Other"), ["Compendium.other.items.Item.shield"]);
	assert.equal(h.index.trees.Item, tree);
	assert.equal(h.counts.full, 0);
	assert.equal(h.counts.wrapped, 1);
});

test("repeated UUID updates use the newest translation once per batch", async () => {
	const h = harness();
	h.update(h.docs.a);
	h.state.titleIndex["example.items"].titles.a = "星辰 长剑";
	h.update(h.docs.a);
	await h.flush();
	assert.deepEqual(h.search("烈焰"), []);
	assert.deepEqual(h.search("星辰"), [h.docs.a.uuid]);
	assert.equal(h.counts.replace, 1);
});

test("a queued document deleted before flushing is removed, not reintroduced", async () => {
	const h = harness();
	h.update(h.docs.a);
	h.pack.index.delete("a");
	await h.flush();
	assert.deepEqual(h.search("Sword"), []);
	assert.deepEqual(h.search("烈焰"), []);
	assert.equal(h.counts.full, 0);
	assert.equal(h.counts.remove, 1);
});

test("entry updates wait for the native index and include updates received while waiting", async () => {
	const h = harness();
	const gate = deferred();
	h.index.ready = gate.promise;
	h.update(h.docs.a);
	const flushing = h.takeTimer();
	await Promise.resolve();
	h.update(h.docs.b);
	assert.equal(h.counts.replace, 0);
	gate.resolve();
	await flushing;
	await h.flush();
	assert.deepEqual(h.search("烈焰"), [h.docs.a.uuid]);
	assert.deepEqual(h.search("寒霜"), [h.docs.b.uuid]);
	assert.equal(h.counts.replace, 2);
	assert.equal(h.counts.full, 0);
});

test("overlapping full rebuilds clear and populate the search index serially", async () => {
	const h = harness();
	await Promise.all([h.context.rebuildDocumentIndexCompat(), h.context.rebuildDocumentIndexCompat()]);
	assert.deepEqual(h.search("World"), ["Item.world"]);
	assert.deepEqual(h.search("Old Sword"), [h.docs.a.uuid]);
	assert.equal(h.counts.full, 2);
});

test("full rebuilds and an entry flush share a barrier and leave no stale search leaves", async () => {
	const h = harness();
	const gate = deferred();
	h.index.ready = gate.promise;
	h.update(h.docs.a);
	const flushing = h.takeTimer();
	const rebuilding = h.context.rebuildDocumentIndexCompat();
	gate.resolve();
	await Promise.all([flushing, rebuilding]);
	await h.flush();
	assert.deepEqual(h.search("烈焰"), [h.docs.a.uuid]);
	h.state.titleIndex["example.items"].titles.a = "明月 长剑";
	h.update(h.docs.a);
	await h.flush();
	assert.deepEqual(h.search("烈焰"), []);
	assert.deepEqual(h.search("明月"), [h.docs.a.uuid]);
	assert.equal(h.counts.full, 1);
});

test("missing incremental APIs retain the full-rebuild fallback", async () => {
	const h = harness();
	h.index.replaceDocument = undefined;
	h.update(h.docs.a);
	await h.flush();
	assert.equal(h.counts.full, 1);
	assert.deepEqual(h.search("烈焰"), [h.docs.a.uuid]);
});

test("a failed incremental update falls back and subsequent batches recover", async () => {
	const h = harness();
	const replace = h.index.replaceDocument;
	h.index.replaceDocument = () => { throw new Error("unavailable index"); };
	h.update(h.docs.a);
	await h.flush();
	assert.equal(h.counts.full, 1);
	assert.deepEqual(h.search("烈焰"), [h.docs.a.uuid]);
	h.index.replaceDocument = replace;
	h.update(h.docs.b);
	await h.flush();
	assert.deepEqual(h.search("寒霜"), [h.docs.b.uuid]);
	assert.equal(h.counts.full, 1);
});

test("a failed full rebuild does not poison the serialization queue", async () => {
	const h = harness();
	const index = h.index.index;
	h.index.index = () => { throw new Error("first build failed"); };
	await assert.rejects(h.context.rebuildDocumentIndexCompat(), /first build failed/);
	h.index.index = index;
	await h.context.rebuildDocumentIndexCompat();
	assert.deepEqual(h.search("World"), ["Item.world"]);
});

test("full loading mode preserves the wrapped return and does not translate or schedule", () => {
	const h = harness();
	h.setMode("full");
	assert.equal(h.update(h.docs.a), h.result);
	assert.equal(h.pack.index.get("a").name, "Old Sword");
	assert.equal(h.counts.wrapped, 1);
	assert.equal(h.timers.size, 0);
});

test("existing Babele translation flags and unrelated metadata survive", async () => {
	const h = harness();
	h.docs.a = { ...h.docs.a, name: "已有完整译名", custom: 17, flags: { babele: { translated: true }, other: { keep: true } } };
	assert.equal(h.update(h.docs.a), h.result);
	await h.flush();
	assert.equal(h.pack.index.get("a").custom, 17);
	assert.equal(h.pack.index.get("a").flags.other.keep, true);
	assert.deepEqual(h.search("已有完整译名"), [h.docs.a.uuid]);
	assert.deepEqual(h.search("烈焰"), []);
});
