import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		// The vitest suite lives outside the build tsconfig (excluded there), so
		// the type-checked rules can't resolve it; lint covers shipped sources.
		'tests/',
		'vitest.config.mts',
		'main.js',
		'versions.json',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
	]),
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mjs', 'manifest.json', 'esbuild.config.mjs', 'version-bump.mjs'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	{
		// Node-only build scripts: Obsidian runtime rules don't apply.
		files: ['esbuild.config.mjs', 'version-bump.mjs'],
		languageOptions: {
			globals: { ...globals.node },
		},
		rules: {
			// Preset aliases core `no-console` under this name.
			'obsidianmd/rule-custom-message': 'off',
			'obsidianmd/no-nodejs-modules': 'off',
		},
	},
);
