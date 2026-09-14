import { NavHistoryEntry } from '@/nav-history/entry';
import { t } from '@/i18n';
import { historyFileOptions } from './listing';

// The file scope: the one-click "only this note" switch, the fixed-label chip
// that opens it, its dropdown of every note the history has been in, and the
// keyboard ownership that goes with an open menu.
//
// TWO controls, ONE state. The switch is the shortcut that was always here — the
// note the pinned card shows, in one click, and still the commonest pick by far.
// The picker generalizes it to any note the history has been in. They can never
// disagree: the switch is checked exactly while the scope IS that note (see
// syncScopeChip), and picking that note in the menu checks it.
//
// The chip's visible label is the SAME string in both states — the action, never
// the file. A label that followed the file name changed the chip's width, and
// with it the search box beside it, the moment a pick was made: the control the
// user had just clicked slid out from under the pointer (and on a narrow strip
// it re-decided which item shared its line). It was redundant as well — every
// row of the narrowed list prints that file and an empty scope names it — and
// the chip itself could only ever show the name TRUNCATED (16em, see
// styles.css). The name survives where it costs no layout: the accessible name
// — the one thing that still spells the state out. Neither control carries a
// TOOLTIP either: each is named by its own visible label, and the two hints that
// used to hang there were a checkbox and a menu saying the same sentence about
// the same note.
//
// The history cannot change while the panel is open (only a jump moves the stack
// pointer, and it closes first), so the item list is a snapshot — which is what
// lets the menu mark the scope in force without rebuilding.

export interface NavScopePickerOptions {
	// The toolbar the controls are built into (they are built once, with it).
	bar: HTMLElement;
	// The history the item list is a snapshot of.
	entries: NavHistoryEntry[];
	// The file the pinned card shows: the switch's note, and the one item's name.
	// undefined for a view step (the graph), and then that item is not offered.
	home: string | undefined;
	// Whether this device keeps its keyboard down.
	mobile: boolean;
	// Put the keyboard back on the search box.
	focusFilter: () => void;
	// The scope changed: the list under it must be redrawn.
	onChange: () => void;
}

export class NavScopePicker {
	// The file the list is narrowed to, or undefined for the whole history.
	// This replaced a boolean "only this note" toggle: the same question —
	// "where else in this note was I" — generalized to any note the history has
	// been in, because the old chip could only ever mean the note the pinned
	// card shows. Off by default, because the question this panel is opened
	// with is usually "where was I", not "where in this note was I".
	private scopeTo: string | undefined = undefined;
	// The direct switch, the chip, its dropdown, and the items in it. The switch
	// exists independently of the chip (a current note is a file, whether or not
	// the rest of the history has any).
	private scopeToggle?: HTMLElement;
	private scopeBox?: HTMLInputElement;
	private scopeButton?: HTMLButtonElement;
	private scopeMenu?: HTMLElement;
	private scopeItems: { path: string | undefined; el: HTMLElement }[] = [];
	// Which item the keyboard is on, and whether the menu is up (see handleKey:
	// while it is, the menu owns the arrow keys, Enter and Escape).
	private scopeActive = 0;
	private scopeOpen = false;

	constructor(private opts: NavScopePickerOptions) {}

	// The scope the list is showing.
	get scope(): string | undefined {
		return this.scopeTo;
	}

	// Build both controls into the toolbar, and point them at the scope in force.
	build(): void {
		this.buildScopeToggle(this.opts.bar);
		this.buildScopePicker(this.opts.bar);
		this.syncScopeChip();
	}

	// The one-click switch to the current note: the file-scope chip's original
	// meaning, kept as a control of its own so the commonest pick never costs a
	// menu. Its label names the ACTION, like the chip's does (a fixed string
	// keeps both widths off the length of a note name); which note "this" is, is
	// the pinned card below.
	private buildScopeToggle(bar: HTMLElement): void {
		const home = this.opts.home;
		if (home === undefined)
			return;
		const label = bar.createEl('label', { cls: 'position-restore-nav-toggle' });
		const box = label.createEl('input', { type: 'checkbox' });
		label.createSpan({ text: t('navHistory.onlyThisFile') });
		box.addEventListener('change', () => {
			// Checked means "only this note"; unchecked means "no scope at all".
			// From a scope on another note the box is already unchecked, so one
			// click lands on this note — which is what its label promises.
			this.pickScope(box.checked ? home : undefined);
		});
		this.scopeToggle = label;
		this.scopeBox = box;
	}

	// The scope chip and its dropdown, built once with the toolbar (see the class
	// comment for why the item list is a snapshot). "All files" is always the
	// first item, so the chip can always say what it is showing and a narrowed
	// list always has a way back.
	private buildScopePicker(bar: HTMLElement): void {
		const files = historyFileOptions(this.opts.entries);
		if (files.length === 0)
			return;

		const wrap = bar.createDiv({ cls: 'position-restore-nav-scope' });
		this.scopeButton = wrap.createEl('button', {
			cls: 'position-restore-nav-scope-btn',
			attr: { type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' },
		});
		// The label is a CONSTANT (see the class comment): written here, once, and
		// no code path ever writes it again — which is exactly what keeps the
		// chip's width off the file the list is showing.
		this.scopeButton.createSpan({ cls: 'nav-scope-label', text: t('navHistory.scope.filter') });
		this.scopeButton.createSpan({ cls: 'nav-scope-caret', text: '▾' });
		this.scopeButton.addEventListener('click', () => this.toggleScopeMenu());
		const menu = wrap.createDiv({
			cls: 'position-restore-nav-scope-menu is-closed',
			attr: { role: 'listbox' },
		});
		this.scopeMenu = menu;

		const add = (path: string | undefined, label: string, folder?: string, count?: number) => {
			const item = menu.createEl('button', {
				cls: 'nav-scope-item',
				attr: { type: 'button', role: 'option' },
			});
			item.createSpan({ text: label, cls: 'nav-scope-item-name' });
			if (folder)
				item.createSpan({ text: folder, cls: 'nav-scope-item-folder' });
			// Zero is left off rather than printed: it is not a selling point,
			// and the empty list it leads to says the same thing better.
			if (count)
				item.createSpan({ text: t('navHistory.scope.count', count), cls: 'nav-scope-item-count' });
			item.addEventListener('click', () => this.pickScope(path));
			this.scopeItems.push({ path, el: item });
		};

		add(undefined, t('navHistory.scope.all'));
		// …and the notes themselves, sorted by name (see historyFileOptions).
		// The note the pinned card shows is in this list like any other: the
		// switch beside the chip is its shortcut, and picking it here just sets
		// the same scope. The count is the list the pick will show, so the
		// current note's own step — the card, never a row — is not counted.
		const home = this.opts.home;
		menu.createDiv({ cls: 'nav-scope-sep' });
		for (const f of files)
			add(f.path, f.name, f.folder, f.count - (f.path === home ? 1 : 0));
	}

	// Point both controls at the scope the list is showing. Scoped, the label
	// takes the normal text colour (its own class, in styles.css) so a narrowed
	// list has a visible cause. Nothing here moves or says anything new on
	// screen: the label TEXT is the fixed action written at build (see the class
	// comment) and there is no tooltip left, so the only thing rewritten is the
	// accessible name.
	private syncScopeChip(): void {
		// The switch is the same state seen from the current note's side: checked
		// exactly while the scope IS the note the pinned card shows.
		const home = this.opts.home;
		if (this.scopeBox && this.scopeToggle) {
			const on = home !== undefined && this.scopeTo === home;
			this.scopeBox.checked = on;
			this.scopeToggle.toggleClass('is-active', on);
		}
		if (!this.scopeButton || !this.scopeMenu)
			return;
		const scoped = this.scopeTo !== undefined;
		this.scopeButton.toggleClass('is-active', scoped);
		// The accessible name is the ONE place the toolbar still spells the scope
		// out: the visible label says "filter by file" whether or not one is in
		// force, and the menu that marks the current item has to be opened first.
		// Set in BOTH states, so the caret is never part of the name either.
		this.scopeButton.setAttr('aria-label', scoped
			? t('navHistory.scope.current', this.scopeTo as string)
			: t('navHistory.scope.filter'));
		this.scopeActive = this.scopeIndexOf();
		this.markScopeActive();
	}

	// Which item stands for the current scope: "all files" (0) when nothing is
	// scoped.
	private scopeIndexOf(): number {
		const at = this.scopeItems.findIndex(it => it.path === this.scopeTo);
		return at === -1 ? 0 : at;
	}

	private markScopeActive(): void {
		this.scopeItems.forEach((it, i) => {
			const on = i === this.scopeActive;
			it.el.toggleClass('is-active', on);
			it.el.setAttr('aria-selected', on ? 'true' : 'false');
		});
		this.scopeItems[this.scopeActive]?.el.scrollIntoView({ block: 'nearest' });
	}

	private toggleScopeMenu(): void {
		if (this.scopeOpen)
			this.closeMenu();
		else
			this.openScopeMenu();
	}

	private openScopeMenu(): void {
		if (!this.scopeMenu || !this.scopeButton)
			return;
		this.scopeOpen = true;
		this.scopeMenu.removeClass('is-closed');
		this.scopeButton.setAttr('aria-expanded', 'true');
		// The keyboard starts on the scope the list already shows, so ↓ walks
		// away from where the user is rather than from the top of the list.
		this.scopeActive = this.scopeIndexOf();
		this.markScopeActive();
		// The filter box keeps the keyboard: typing is how the list underneath is
		// narrowed, and the browser's keydown handler routes ↓/↑/Enter to the menu
		// while it is open (see handleKey). A touch device is left alone —
		// taking the focus there raises the on-screen keyboard over the list.
		if (!this.opts.mobile)
			this.opts.focusFilter();
	}

	// Put the menu away. Also the browser's click-anywhere-else handler.
	closeMenu(): void {
		if (!this.scopeOpen || !this.scopeMenu || !this.scopeButton)
			return;
		this.scopeOpen = false;
		this.scopeMenu.addClass('is-closed');
		this.scopeButton.setAttr('aria-expanded', 'false');
	}

	private moveScopeActive(d: number): void {
		const n = this.scopeItems.length;
		if (n === 0)
			return;
		this.scopeActive = (this.scopeActive + d + n) % n;
		this.markScopeActive();
	}

	// While the scope menu is up it owns the same keys the list does. The
	// selection behind an overlay must not move where the user cannot see it,
	// Enter must pick the menu's item, and Escape must put the MENU away rather
	// than the whole panel — the modal's Escape is the app's own keymap on
	// document, so stopping the event here is what keeps this dialog open for one
	// more look at the list. Returns true when the menu consumed the key.
	handleKey(ev: KeyboardEvent): boolean {
		if (!this.scopeOpen)
			return false;
		if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
			ev.preventDefault();
			this.moveScopeActive(ev.key === 'ArrowDown' ? 1 : -1);
			return true;
		}
		if (ev.key === 'Enter') {
			// An item the user tabbed to handles its own Enter (a focused
			// button fires click); the active item is for the case where the
			// focus is still on the chip.
			if ((ev.target as HTMLElement | null)?.closest?.('.nav-scope-item'))
				return true;
			ev.preventDefault();
			this.pickScope(this.scopeItems[this.scopeActive]?.path);
			return true;
		}
		if (ev.key === 'Escape') {
			ev.preventDefault();
			ev.stopPropagation();
			this.closeMenu();
			return true;
		}
		// A key that EDITS text means the user has decided to type a filter
		// rather than pick a file: the menu gets out of the way and the key
		// lands in the box (which openScopeMenu left focused). Not consumed —
		// the list's own keys are not editing keys, so there is nothing left to
		// do with it either way.
		if (ev.key.length === 1 || ev.key === 'Backspace' || ev.key === 'Delete') {
			if (!ev.ctrlKey && !ev.metaKey && !ev.altKey)
				this.closeMenu();
		}
		return false;
	}

	// Choosing an item NARROWS the list to that file; it does not travel there.
	// A file holds several landings and which one is the entire question the
	// list is on screen to answer — a jump here would both guess and close the
	// panel before the user could look. Picking the scope already in force just
	// puts the menu away.
	private pickScope(path: string | undefined): void {
		this.closeMenu();
		// The search box is this toolbar's keyboard surface and the browser's
		// keydown handler routes every key through it: a click that narrows the
		// list must not cost the user the ability to keep typing in it. On touch,
		// though, taking the focus IS the cost — it raises the on-screen keyboard
		// over the list the user is narrowing.
		if (!this.opts.mobile)
			this.opts.focusFilter();
		if (path === this.scopeTo)
			return;
		this.scopeTo = path;
		this.syncScopeChip();
		this.opts.onChange();
	}
}
