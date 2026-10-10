// 只挂一条规则：CSS 特性的浏览器兼容性检查（doiuse + caniuse 数据库）。Obsidian 官方
// 社区目录在每次发布后跑的自动审核用的就是同一个引擎，消息形如
// `Unexpected browser feature "multicolumn" is only partially supported ...`。
// 官方扫描器读的是仓库里的源文件、且不看 manifest.json 的 minAppVersion，基线是它
// 自己记录的一组旧版 Obsidian（目前最低 Chromium 144，即 Obsidian 1.11 代的
// Electron 40；146/148/150 也在同一组里）。这里对齐这条基线，让审核会报的东西
// 在本地和发版 CI 里先报出来，而不是等发布页面扣分。
// 注意它按属性名归类、不看上下文：flex/grid 容器里的 `column-gap` 也会被算成
// multicolumn（多列排版对分页断行的支持至今标着 partial），改成 `gap` 即可。
import noUnsupportedBrowserFeatures from 'stylelint-no-unsupported-browser-features';

/** @type {import('stylelint').Config} */
export default {
	plugins: [noUnsupportedBrowserFeatures],
	rules: {
		'plugin/no-unsupported-browser-features': [
			true,
			{
				// 与官方审核的最低内核基线一致，不是本插件的 minAppVersion。
				browsers: ['Chrome >= 144'],
				// 判 error：发版 CI 必须过这关。确认是误报且没有等价写法时，再把
				// caniuse 特性名加进 ignore 并在本文件注释里写明理由，不许静默吞掉。
				severity: 'error',
			},
		],
	},
};
