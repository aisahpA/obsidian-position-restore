// 「浏览最近文件」面板：包在浏览器主体外面的**模态**外壳（凡不是外壳的东西见 body.ts，
// 共用它的常驻侧栏面板见 view.ts）。
//
// 什么让它成为模态、别的东西做不到：一个自己有生命期的对话框，一旦某一行被行进过去
// 就关闭，打开时筛选框已获得焦点。
//
// 它也是**唯一**不订阅地点的外壳：对话框是一个问出来、又被回答的问题，而它的列表
// 能看到的唯一变化，是它自己的读者从某一行的菜单里做出来的，那个变化由主体自己重画。
// 一个一直站着不走的则是相反的情形，也正是那个订阅存在的理由。

import { App, Modal, Platform } from 'obsidian';
import { PlaceList } from '@/recent-files/places';
import { EphemeralState } from '@/types';
import { t } from '@/i18n';
import { FIXED_HEIGHT_MIN_ENTRIES } from './constants';
import { RecentFilesBrowser, RecentFilesBrowserArrows, RecentFilesBrowserPrefs } from './body';

export class RecentFilesModal extends Modal {
	// 工具栏、行与键盘。
	private browser!: RecentFilesBrowser;
	// 在这里只读一次：它决定提示语，以及筛选框是否自己获得焦点。
	private mobile = Platform.isMobile;

	constructor(
		app: App,
		// 面板唯一的数据来源。
		private places: PlaceList,
		private savedPosition: ((path: string) => EphemeralState | undefined) | undefined,
		// 插件拥有并持久化这些；这个外壳只是把它们往下交。
		private prefs: RecentFilesBrowserPrefs,
		// 四个箭头：后退与前进各一步，以及读者打开的那篇笔记的两端。每个外壳都画它们
		// （见 RecentFilesBrowserArrows），而对话框在每一个上都关闭 —— 它盖住了它们
		// 所作用的那篇笔记。
		private arrows: RecentFilesBrowserArrows,
	) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass('position-restore-nav-modal');
		// 两个外壳共用的 class：面板的呈现规则就是照它写的（见 styles.css），
		// 好让对话框和侧栏面板不会在各自的安静层档、内联面板或触摸布局上漂开。
		this.modalEl.addClass('position-restore-nav-panel');
		// 在这里钉一次。对话框开着时仍可能有行离开 —— 读者可能从某行自己的菜单里撤下一个 ——
		// 列表就干脆短一行出来。
		this.modalEl.toggleClass('is-touch', this.mobile);
		// 任何带键盘的东西上都钉住，无论列表里有什么：筛选不能改变对话框大小、也不能让它
		// 重新居中。手机让它的短历史按自身来定尺寸 —— 见 FIXED_HEIGHT_MIN_ENTRIES。
		this.modalEl.toggleClass('is-fixed', !this.mobile || this.places.entries.length > FIXED_HEIGHT_MIN_ENTRIES);
		// 有键盘就有一个框站在 app 自己的 prompt 放它的地方，上面没有东西压着 ——
		// 所以框自己的 × 既是回家的路、也是出去的路：有查询就清掉，空框就关闭
		// （见 RecentFilesBrowser.toolbar，以及 styles.css 里 app 自己的 × 让出来
		// 而不是共用的那个角落）。
		this.modalEl.toggleClass('is-dismissive', !this.mobile);
		this.titleEl.setText(t('recentFiles.name'));
		this.browser = new RecentFilesBrowser({
			app: this.app,
			places: this.places,
			host: this.contentEl,
			savedPosition: this.savedPosition,
			touch: this.mobile,
			// 对话框不需要折叠 —— 第一次行进就会关掉它。
			collapseOnJump: false,
			focusFilter: true,
			// 一旦某一行被行进过去，对话框就算答完了它的问题，所以它先让开路、打开再自己跑。
			// （侧栏外壳这里什么都不传：一直站着不走正是它的意义。）
			onJump: () => this.close(),
			// 框的 × 在没有东西可清时关闭，是对话框自己的承诺、与行进无关：面板从未移动过。
			onDismiss: () => this.close(),
			arrows: this.arrows,
			prefs: this.prefs,
		});
		this.browser.mount();
	}

	onClose() {
		this.browser.destroy();
	}

}
