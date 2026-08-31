import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
	resolve: {
		// 'obsidian' is a typings-only package with no runnable entry; point
		// the whole suite (sources under test included) at a runtime stand-in.
		alias: {
			obsidian: fileURLToPath(new URL('./tests/obsidian-stub.ts', import.meta.url)),
		},
	},
	test: {
		environment: 'jsdom',
	},
});
