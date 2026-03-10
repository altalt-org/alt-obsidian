/**
 * Simple i18n module for Alt plugin
 */

import { en } from './en';
import { ko } from './ko';

export type SupportedLocale = 'en' | 'ko';

type TranslationKey = keyof typeof en;

const translations: Record<SupportedLocale, Record<string, string>> = {
	en,
	ko,
};

let currentLocale: SupportedLocale = 'en';

export function setLocale(locale: string): void {
	const code = locale.split('-')[0].toLowerCase();
	currentLocale = code in translations ? (code as SupportedLocale) : 'en';
}

export function getLocale(): SupportedLocale {
	return currentLocale;
}

/**
 * Get translated string by key.
 * Falls back to English if key not found in current locale.
 */
export function t(key: TranslationKey): string {
	return translations[currentLocale]?.[key] ?? translations['en']?.[key] ?? key;
}
