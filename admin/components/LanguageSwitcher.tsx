'use client';

import { useRouter, usePathname } from 'next/navigation';
import { useCurrentLocale } from '@/lib/i18n/client';
import { locales, localeNames } from '@/lib/i18n/config';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export default function LanguageSwitcher() {
  const router = useRouter();
  const pathname = usePathname();
  const locale = useCurrentLocale();

  const handleChange = (newLocale: string) => {
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
    <Select value={locale} onValueChange={handleChange}>
      <SelectTrigger className="w-[140px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {locales.map((loc) => (
          <SelectItem key={loc} value={loc}>
            {localeNames[loc]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
