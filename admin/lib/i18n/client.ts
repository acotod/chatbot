'use client';

import { useLocale, useTranslations as useNextIntlTranslations } from 'next-intl';
import { Locale } from './config';

export function useTranslations(namespace?: string) {
  return useNextIntlTranslations(namespace);
}

export function useCurrentLocale(): Locale {
  return useLocale() as Locale;
}
