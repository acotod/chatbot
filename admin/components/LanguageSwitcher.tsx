'use client';

import { useRouter, usePathname } from 'next/navigation';
import { useCurrentLocale } from '@/lib/i18n/client';
import { locales, localeNames } from '@/lib/i18n/config';

export default function LanguageSwitcher() {
  const router = useRouter();
  const pathname = usePathname();
  const locale = useCurrentLocale();

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

    // Remove the current locale prefix and add the new one
    let newPathname = pathname;
    
    // Remove current locale prefix if it exists
    if (pathname.startsWith(`/${locale}`)) {
      newPathname = pathname.slice(locale.length + 1);
    }
    
    // Add new locale prefix (skip if it's the default locale 'es')
    if (newLocale === 'es') {
      newPathname = `/${newPathname}`;
    } else {
      newPathname = `/${newLocale}${newPathname}`;
    }
    
    // Clean up double slashes
    newPathname = newPathname.replace(/\/+/g, '/');
    
    router.push(newPathname);
    localStorage.setItem('preferredLocale', newLocale);
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
            {localeNames[loc]}
          </option>
        ))}
      </select>
    </div>
  );
}
