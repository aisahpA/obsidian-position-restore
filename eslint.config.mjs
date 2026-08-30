import { defineConfig } from 'eslint/config';
import globals from 'globals';
import obsidianmd from 'eslint-plugin-obsidianmd';

// Official Obsidian plugin-review lint setup:
// https://github.com/obsidianmd/eslint-plugin
// `recommended` already bundles eslint core + typescript-eslint type-checked
// rules + Obsidian-specific rules — don't add those presets separately.
export default defineConfig([
	{ ignores: ['main.js', 'node_modules/'] },
	...obsidianmd.configs.recommended,
	{
		// Node-only build scripts: Obsidian runtime rules don't apply.
		files: ['rollup.config.js', 'version-bump.mjs'],
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
						'rollup.config.js',
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
