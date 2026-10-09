// shared/frontmatter.ts 的测试：一条 `prop[: value]` 条目意味着什么。这个写法由位置记录
// 规则和最近文件列表共用，所以在哪个设置页上敲下的规则都必须含义相同 —— 而一条命中得
// 比它说的还多的规则，会悄悄让位置记不下来。

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
		// 一个布尔属性不会匹配另一种写法
		expect(matches('publish: false')).toBe(false);
	});

	it('列表只要有一个元素命中就算', () => {
		expect(matches('tags: b')).toBe(true);
		expect(matches('tags: c')).toBe(false);
	});

	// 这个文件就是为这个 bug 写的：`in` 会走原型链，而一条只有名字的条目从不看值，所以下面
	// 每一个都能命中每篇带着任何 frontmatter 的笔记。
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
