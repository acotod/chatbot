import { getRequestConfig } from 'next-intl/server';
import { locales, defaultLocale } from './config';

export default getRequestConfig(async ({ requestLocale }) => {
  let locale = requestLocale;

  if (!locale || !locales.includes(locale as any)) {
    locale = defaultLocale;
  }

  const [common, dashboard, errors, solicitudes, conversaciones, agenda, contactos, settings] = await Promise.all([
    import(`../../public/locales/${locale}/common.json`),
    import(`../../public/locales/${locale}/dashboard.json`),
    import(`../../public/locales/${locale}/errors.json`),
    import(`../../public/locales/${locale}/solicitudes.json`),
    import(`../../public/locales/${locale}/conversaciones.json`),
    import(`../../public/locales/${locale}/agenda.json`),
    import(`../../public/locales/${locale}/contactos.json`),
    import(`../../public/locales/${locale}/settings.json`),
  ]);

  return {
    locale,
    messages: {
      common: common.default,
      dashboard: dashboard.default,
      errors: errors.default,
      solicitudes: solicitudes.default,
      conversaciones: conversaciones.default,
      agenda: agenda.default,
      contactos: contactos.default,
      settings: settings.default,
    },
  };
});
