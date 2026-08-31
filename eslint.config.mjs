import { defineConfig } from 'eslint/config';
import globals from 'globals';
import obsidianmd from 'eslint-plugin-obsidianmd';

// Official Obsidian plugin-review lint setup:
// https://github.com/obsidianmd/eslint-plugin
// `recommended` already bundles eslint core + typescript-eslint type-checked
// rules + Obsidian-specific rules — don't add those presets separately.
export default defineConfig([
	// The vitest suite lives outside the build tsconfig (excluded there), so
	// the type-checked rules can't resolve it; lint covers shipped sources.
	{ ignores: ['main.js', 'node_modules/', 'tests/', 'vitest.config.mts'] },
	...obsidianmd.configs.recommended,
	{
		// Node-only build scripts: Obsidian runtime rules don't apply.
		files: ['rollup.config.mjs', 'version-bump.mjs'],
		languageOptions: {
			globals: { ...globals.node },
		},
		rules: {
			// Preset aliases core `no-console` under this name.
			'obsidianmd/rule-custom-message': 'off',
			'obsidianmd/no-nodejs-modules': 'off',
		},
	},
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.*',
						'rollup.config.mjs',
						'version-bump.mjs',
					],
				},
			},
		},
	},
	{
		// Prototype patches must stay real functions (their `this` is the
		// leaf/workspace), so capturing the plugin instance under a fixed
		// alias is intentional.
		files: ['**/*.{ts,cts,mts,tsx}'],
		rules: {
			'@typescript-eslint/no-this-alias': [
				'error',
				{ allowedNames: ['patcher'] },
			],
		},
	},
]);
