export const locales = ['en', 'es'] as const;
export const defaultLocale = 'es' as const;
export type Locale = (typeof locales)[number];

export const localeNames: Record<Locale, string> = {
  en: 'English',
  es: 'Español',
};
