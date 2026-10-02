import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		// vitest 套件在构建用的 tsconfig 之外（被它排除），所以带类型检查的
		// 规则解析不了它；lint 只覆盖发布出去的源码。
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
		// 只在 Node 里跑的构建脚本：Obsidian 运行时规则不适用。
		files: ['esbuild.config.mjs', 'version-bump.mjs'],
		languageOptions: {
			globals: { ...globals.node },
		},
		rules: {
			// 预设在把 core 的 `no-console` 改名到这个名下。
			'obsidianmd/rule-custom-message': 'off',
			'obsidianmd/no-nodejs-modules': 'off',
		},
	},
);
