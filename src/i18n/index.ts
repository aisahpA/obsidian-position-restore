import { getLanguage } from 'obsidian';
import { en, type En } from './locales/en';
import { zh } from './locales/zh';

const dicts: Record<string, En> = { en, zh };

const dict: En = dicts[getLanguage().toLowerCase().split(/[-_]/)[0]] ?? en;

export function t<K extends keyof En>(key: K, ...args: (string | number)[]): string {
	let s = dict[key];
	args.forEach((a, i) => {
		s = s.split(`{${i}}`).join(String(a));
	});
	return s;
}
