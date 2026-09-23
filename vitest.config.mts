import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
	resolve: {
		// The array form is required for both entries: '@/x' needs a regex to
		// match the segment after the slash, and a bare '@' string would also
		// capture '@codemirror/...'. '@/x' -> src/ mirrors tsconfig `paths`
		// — which is the same mapping esbuild resolves from tsconfig while bundling.
		alias: [
			{ find: /^@\//, replacement: fileURLToPath(new URL('./src/', import.meta.url)) },
			// 'obsidian' is a typings-only package with no runnable entry; point
			// the whole suite (sources under test included) at a runtime stand-in.
			{ find: 'obsidian', replacement: fileURLToPath(new URL('./tests/support/obsidian-stub.ts', import.meta.url)) },
		],
	},
	test: {
		environment: 'jsdom',
	},
});
