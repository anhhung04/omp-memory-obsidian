import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultIndex } from "../src/vault/index";
import { VaultStore } from "../src/vault/store";
import { extractLinks, rebuildMasterIndex } from "../src/vault/wiki";

let dir: string;
let store: VaultStore;
let index: VaultIndex;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "vault-test-"));
	store = await VaultStore.open(dir);
	index = new VaultIndex(store);
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("extractLinks", () => {
	test("finds slugs, strips labels, dedupes case-insensitively", () => {
		const links = extractLinks("See [[Omp-Config|the config]] and [[omp-config]] plus [[other]]. Not [single] brackets.");
		expect(links).toEqual(["omp-config", "other"]);
	});
});

describe("rebuildMasterIndex", () => {
	test("groups topics by first tag, excludes daily logs", async () => {
		await store.upsertTopic({ slug: "b-topic", title: "B topic", body: "x", tags: ["beta"] });
		await store.upsertTopic({ slug: "a-topic", title: "A topic", body: "x", tags: ["alpha"] });
		await store.upsertTopic({ slug: "no-tag", title: "No tag", body: "x" });
		await store.appendDaily("daily noise", new Date());

		const count = await rebuildMasterIndex(store);
		expect(count).toBe(3);

		const master = await store.readPage("MEMORY.md");
		expect(master?.body).toContain("## alpha\n\n- [[a-topic]] — A topic");
		expect(master?.body).toContain("## beta\n\n- [[b-topic]] — B topic");
		expect(master?.body).toContain("## untagged\n\n- [[no-tag]] — No tag");
		expect(master?.body).not.toContain("daily noise");
	});
});

describe("VaultIndex.search", () => {
	test("title match outranks body-only mention", async () => {
		await store.upsertTopic({ slug: "mnemopi", title: "Mnemopi backend", body: "SQLite memory.", tags: ["memory"] });
		await store.upsertTopic({ slug: "other", title: "Other notes", body: "mnemopi mnemopi mnemopi mentioned often." });

		const hits = await index.search("mnemopi");
		expect(hits[0]?.path).toBe("topics/mnemopi.md");
	});

	test("snippet contains the matched token; related links are surfaced", async () => {
		await store.upsertTopic({ slug: "vault", title: "Vault", body: "Stores memories. See [[mnemopi]]." });
		const hits = await index.search("memories");
		expect(hits[0]?.snippet).toContain("memories");
		expect(hits[0]?.related).toEqual(["mnemopi"]);
	});

	test("reflects writes without manual rebuild (store onChange invalidation)", async () => {
		await store.upsertTopic({ slug: "one", title: "One", body: "alpha" });
		expect((await index.search("alpha")).length).toBe(1);
		await store.upsertTopic({ slug: "two", title: "Two", body: "beta" });
		expect((await index.search("beta")).length).toBe(1);
		await store.deletePage("topics/one.md");
		expect((await index.search("alpha")).length).toBe(0);
	});

	test("stopword-only query matches nothing", async () => {
		await store.upsertTopic({ slug: "one", title: "One", body: "the and for" });
		expect(await index.search("the and for")).toEqual([]);
	});
});
