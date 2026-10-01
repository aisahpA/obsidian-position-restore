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
	it('没有规则可问时为 false', () => {
		expect(frontmatterRuleMatches(fm, [])).toBe(false);
		expect(frontmatterRuleMatches(undefined, ['status'])).toBe(false);
		expect(frontmatterRuleMatches('text', ['status'])).toBe(false);
		expect(matches('', '   ')).toBe(false);
	});

	it('只写名字时，属性不管持有什么值都命中', () => {
		expect(matches('status')).toBe(true);
		expect(matches('publish')).toBe(true);
		expect(matches('draft')).toBe(true);
		expect(matches('version')).toBe(true);
	});

	it('只写名字时，笔记没有的那个属性不命中', () => {
		expect(matches('statusx')).toBe(false);
		expect(matches('statu')).toBe(false);
	});

	it('带值时按不区分大小写比较，数字按写下的样子匹配', () => {
		expect(matches('status: archived')).toBe(true);
		expect(matches('status: ARCHIVED')).toBe(true);
		expect(matches('status: draft')).toBe(false);
		expect(matches('version: 3')).toBe(true);
		expect(matches('version: 4')).toBe(false);
	});

	it('两边的布尔别名都接受', () => {
		expect(matches('publish: true', 'publish: yes', 'publish: on')).toBe(true);
		expect(matches('draft: false', 'draft: no', 'draft: off')).toBe(true);
		// a boolean property does not match the other spelling
		expect(matches('publish: false')).toBe(false);
	});

	it('列表只要有一个元素命中就算', () => {
		expect(matches('tags: b')).toBe(true);
		expect(matches('tags: c')).toBe(false);
	});

	// The bug this file was written for: `in` walks the prototype chain, and a
	// name-only entry never looks at the value, so every one of these matched
	// every note carrying any frontmatter at all.
	it('笔记只是继承来的名字永不命中', () => {
		for (const inherited of ['toString', 'valueOf', 'constructor', 'hasOwnProperty', '__proto__'])
			expect(matches(inherited)).toBe(false);
		expect(matches('toString: x')).toBe(false);
	});

	it('属性名保持笔记写下的那个大小写', () => {
		expect(matches('MyProp')).toBe(true);
		expect(matches('myprop')).toBe(false);
	});

	it('空值表示「存在即可」，不是去匹配空文本', () => {
		expect(matches('status:')).toBe(true);
	});
});
