'use client';

import { usePathname } from 'next/navigation';
import { useCurrentLocale } from '@/lib/i18n/client';
import { locales } from '@/lib/i18n/config';

export default function LanguageSwitcher() {
  const pathname = usePathname();
  const locale = useCurrentLocale();
  const localeLabels =
    locale === 'es'
      ? { en: 'Ingles', es: 'Espanol' }
      : { en: 'English', es: 'Spanish' };

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newLocaleValue = e.target.value;
    const newLocale = String(newLocaleValue ?? '').trim();
    if (!newLocale || !locales.includes(newLocale as (typeof locales)[number])) 
    {
      return;
    }

    if (newLocale === locale) {
      return;
    }

    const basePath = pathname.replace(/^\/(en|es)(?=\/|$)/, '') || '/';

    // Keep middleware locale detection and the next request in sync.
    document.cookie = `NEXT_LOCALE=${newLocale}; path=/; max-age=31536000; samesite=lax`;

    const search = typeof window !== 'undefined' ? window.location.search : '';
    const hash = typeof window !== 'undefined' ? window.location.hash : '';
    const targetPath = newLocale === 'es' ? basePath : `/${newLocale}${basePath}`;
    window.location.assign(targetPath);

    try {
      localStorage.setItem('preferredLocale', newLocale);
    } catch {
      // Ignore storage failures in restricted browser contexts.
    }
  };

  return (
    <div className="relative">
      <select
        value={locale}
        onChange={handleChange}
        className="w-[140px] px-3 py-2 bg-white border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 text-sm"
        aria-label="Language selector"
      >
        {locales.map((loc) => (
          <option key={loc} value={loc}>
            {localeLabels[loc]}
          </option>
        ))}
      </select>
    </div>
  );
}
