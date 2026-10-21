import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePage, serializePage, slugify, VaultStore } from "../src/vault/store";

let dir: string;
let store: VaultStore;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "vault-test-"));
	store = await VaultStore.open(dir);
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("frontmatter codec", () => {
	test("serialize → parse roundtrips all fields", () => {
		const meta = {
			title: 'He said "hi": a story',
			created: "2026-10-21T10:00:00.000Z",
			updated: "2026-10-21T11:00:00.000Z",
			source: "retain",
			importance: 4,
			tags: ["omp", "memory, with comma"],
		};
		const page = parsePage("topics/x.md", serializePage(meta, "# Body\n\ntext\n"));
		expect(page.meta).toEqual(meta);
		expect(page.body).toBe("# Body\n\ntext\n");
	});

	test("parses Obsidian block-style arrays", () => {
		const raw = "---\ntitle: X\ntags:\n  - alpha\n  - beta\n---\n\nbody\n";
		const page = parsePage("topics/x.md", raw);
		expect(page.meta.tags).toEqual(["alpha", "beta"]);
		expect(page.body).toBe("body\n");
	});

	test("no frontmatter → whole file is body", () => {
		const page = parsePage("topics/x.md", "# Just markdown\n");
		expect(page.body).toBe("# Just markdown\n");
		expect(page.meta.title).toBe("topics/x.md");
	});
});

describe("slugify", () => {
	test("normalizes to kebab-case", () => {
		expect(slugify("Omp Config: Memory!")).toBe("omp-config-memory");
		expect(slugify("  ---  ")).toBe("untitled");
	});
});

describe("upsertTopic", () => {
	test("creates, merges with dated section, dedupes identical content", async () => {
		const first = await store.upsertTopic({ slug: "omp-config", title: "Omp config", body: "Uses YAML.", tags: ["omp"], importance: 3 });
		expect(first.created).toBe(true);

		const later = new Date(Date.now() + 60_000);
		const second = await store.upsertTopic(
			{ slug: "omp-config", title: "Omp config", body: "Settings live in config.yml.", tags: ["config"], importance: 5 },
			later,
		);
		expect(second.merged).toBe(true);

		const page = await store.readPage("topics/omp-config.md");
		expect(page?.body).toContain("Uses YAML.");
		expect(page?.body).toContain(`## ${later.toISOString().slice(0, 10)}`);
		expect(page?.body).toContain("Settings live in config.yml.");
		expect(page?.meta.tags).toEqual(["omp", "config"]);
		expect(page?.meta.importance).toBe(5);
		expect(page?.meta.created).not.toBe(page?.meta.updated);

		const dupe = await store.upsertTopic({ slug: "omp-config", title: "Omp config", body: "Settings live in config.yml." });
		expect(dupe.merged).toBe(false);
		const after = await store.readPage("topics/omp-config.md");
		expect(after?.body.match(/Settings live in config\.yml\./g)).toHaveLength(1);
	});
});

describe("appendDaily", () => {
	test("creates today's log, then appends under new headings", async () => {
		const now = new Date("2026-10-21T12:30:00.000Z");
		const rel = await store.appendDaily("first entry", now);
		expect(rel).toBe("daily/2026-10-21.md");
		await store.appendDaily("second entry", new Date("2026-10-21T13:45:00.000Z"));
		const page = await store.readPage(rel);
		expect(page?.body).toContain("### 12:30\nfirst entry");
		expect(page?.body).toContain("### 13:45\nsecond entry");
	});

	test("concurrent appends to the same day both land", async () => {
		const now = new Date("2026-10-21T12:00:00.000Z");
		await Promise.all([...Array(10)].map((_, i) => store.appendDaily(`entry-${i}`, now)));
		const page = await store.readPage("daily/2026-10-21.md");
		for (let i = 0; i < 10; i++) expect(page?.body).toContain(`entry-${i}`);
	});
});

describe("safety", () => {
	test("rejects paths escaping the vault", async () => {
		await expect(store.readPage("../../etc/passwd")).rejects.toThrow("escapes vault");
		await expect(store.writePage("../evil.md", { title: "x", created: "", updated: "" }, "x")).rejects.toThrow("escapes vault");
	});

	test("listPages skips dotfiles and non-markdown", async () => {
		await store.upsertTopic({ slug: "a", title: "A", body: "body a" });
		await store.appendDaily("log", new Date());
		const pages = await store.listPages();
		expect(pages).toEqual(["daily/" + new Date().toISOString().slice(0, 10) + ".md", "topics/a.md"]);
	});

	test("deletePage reports existence", async () => {
		await store.upsertTopic({ slug: "gone", title: "Gone", body: "x" });
		expect(await store.deletePage("topics/gone.md")).toBe(true);
		expect(await store.deletePage("topics/gone.md")).toBe(false);
	});
});
