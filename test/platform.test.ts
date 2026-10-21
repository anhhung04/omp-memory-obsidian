import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { defaultVaultRoot, isWSL } from "../src/vault/platform";

// defaultVaultRoot reads WSL_INTEROP / WSL_DISTRO_NAME / USERPROFILE /
// OMP_MEMORY_WINDOWS_USER / USER and probes /proc/version — tests pin each
// axis and restore the real env afterwards.

const TOUCHED = ["WSL_INTEROP", "WSL_DISTRO_NAME", "USERPROFILE", "OMP_MEMORY_WINDOWS_USER"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
	saved = Object.fromEntries(TOUCHED.map(k => [k, process.env[k]]));
	for (const key of TOUCHED) delete process.env[key];
});

afterEach(() => {
	for (const key of TOUCHED) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
});

describe("isWSL", () => {
	test("env marker forces detection", () => {
		process.env.WSL_DISTRO_NAME = "Ubuntu";
		expect(isWSL()).toBe(true);
	});
});

describe("defaultVaultRoot", () => {
	test("no WSL markers on bare Linux → agent memories dir", () => {
		if (isWSL()) return; // genuinely under WSL: nothing to assert here
		expect(defaultVaultRoot()).toBe(join(process.env.HOME ?? "", ".omp", "agent", "memory-vault"));
	});

	test("WSL without drvfs falls back to Linux home, never guesses /mnt/c", () => {
		if (existsSync("/mnt/c")) return; // host has drvfs; this fallback is covered by manual WSL verification
		process.env.WSL_DISTRO_NAME = "Ubuntu";
		expect(defaultVaultRoot()).toBe(join(process.env.HOME ?? "", ".omp", "agent", "memory-vault"));
	});
});
