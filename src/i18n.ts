import { en, type En } from './locales/en';
import { zh } from './locales/zh';

declare global {
	interface Window {
		moment: { locale: () => string };
	}
}

const lang: En = window.moment.locale().toLowerCase().startsWith('zh') ? zh : en;

export function t<K extends keyof En>(key: K, ...args: string[]): string {
	let s = lang[key];
	args.forEach((a, i) => {
		s = s.replace(`{${i}}`, a);
	});
	return s;
}
