// Tests for shared/frontmatter.ts: what one `prop[: value]` entry means. The
// form is shared by the position recording rules and the recent-files list, so
// a rule typed on either settings page has to mean the same thing — and a rule
// that matches more than it says silently stops positions being recorded.

import { describe, it, expect } from 'vitest';
import { frontmatterRuleMatches } from '@/shared/frontmatter';

const fm = {
	title: 'My Note',
	status: 'Archived',
	publish: true,
	draft: false,
	version: 3,
	tags: ['a', 'b'],
	MyProp: 'yes',
};

const matches = (...entries: string[]) => frontmatterRuleMatches(fm, entries);

describe('frontmatterRuleMatches', () => {
	it('is false with nothing to ask', () => {
		expect(frontmatterRuleMatches(fm, [])).toBe(false);
		expect(frontmatterRuleMatches(undefined, ['status'])).toBe(false);
		expect(frontmatterRuleMatches('text', ['status'])).toBe(false);
		expect(matches('', '   ')).toBe(false);
	});

	it('a name alone matches whatever value the property holds', () => {
		expect(matches('status')).toBe(true);
		expect(matches('publish')).toBe(true);
		expect(matches('draft')).toBe(true);
		expect(matches('version')).toBe(true);
	});

	it('a name alone does not match a property the note does not carry', () => {
		expect(matches('statusx')).toBe(false);
		expect(matches('statu')).toBe(false);
	});

	it('a value compares case-insensitively, and matches numbers as written', () => {
		expect(matches('status: archived')).toBe(true);
		expect(matches('status: ARCHIVED')).toBe(true);
		expect(matches('status: draft')).toBe(false);
		expect(matches('version: 3')).toBe(true);
		expect(matches('version: 4')).toBe(false);
	});

	it('accepts the boolean aliases on either side', () => {
		expect(matches('publish: true', 'publish: yes', 'publish: on')).toBe(true);
		expect(matches('draft: false', 'draft: no', 'draft: off')).toBe(true);
		// a boolean property does not match the other spelling
		expect(matches('publish: false')).toBe(false);
	});

	it('a list matches when any element does', () => {
		expect(matches('tags: b')).toBe(true);
		expect(matches('tags: c')).toBe(false);
	});

	// The bug this file was written for: `in` walks the prototype chain, and a
	// name-only entry never looks at the value, so every one of these matched
	// every note carrying any frontmatter at all.
	it('never matches a name the note only inherits', () => {
		for (const inherited of ['toString', 'valueOf', 'constructor', 'hasOwnProperty', '__proto__'])
			expect(matches(inherited)).toBe(false);
		expect(matches('toString: x')).toBe(false);
	});

	it('keeps the case the note wrote the property in', () => {
		expect(matches('MyProp')).toBe(true);
		expect(matches('myprop')).toBe(false);
	});

	it('an empty value is the presence form, not a match for empty text', () => {
		expect(matches('status:')).toBe(true);
	});
});
