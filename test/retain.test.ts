import { describe, expect, test } from "bun:test";
import { parseExtraction } from "../src/extension/retain";

describe("parseExtraction", () => {
	test("parses a clean array", () => {
		const items = parseExtraction(
			'[{"title":"Omp config","summary":"Settings live in config.yml.","topic":"Omp Config","tags":["omp"],"importance":4}]',
		);
		expect(items).toEqual([{ title: "Omp config", summary: "Settings live in config.yml.", topic: "omp-config", tags: ["omp"], importance: 4 }]);
	});

	test("tolerates prose around the JSON", () => {
		const items = parseExtraction('Here you go:\n[{"title":"A","summary":"B"}]\nHope that helps!');
		expect(items).toEqual([{ title: "A", summary: "B", topic: undefined, tags: [], importance: 3 }]);
	});

	test("empty array means nothing durable, not an error", () => {
		expect(parseExtraction("[]")).toEqual([]);
	});

	test("garbage returns undefined", () => {
		expect(parseExtraction("no json here")).toBeUndefined();
		expect(parseExtraction("[{broken")).toBeUndefined();
		expect(parseExtraction('{"title":"not an array"}')).toBeUndefined();
	});

	test("skips malformed items, clamps importance, drops bad tags", () => {
		const items = parseExtraction(
			JSON.stringify([
				{ title: "", summary: "no title" },
				{ title: "No summary" },
				{ title: "Ok", summary: "Fine.", importance: 99, tags: ["good", 42, "  "] },
				{ title: "Low", summary: "Fine.", importance: -3 },
			]),
		);
		expect(items).toHaveLength(2);
		expect(items?.[0]).toMatchObject({ title: "Ok", importance: 5, tags: ["good"] });
		expect(items?.[1]).toMatchObject({ title: "Low", importance: 1 });
	});
});
