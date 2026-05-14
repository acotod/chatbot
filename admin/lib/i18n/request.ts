import { getRequestConfig } from 'next-intl/server';
import { locales, defaultLocale, type Locale } from './config';

export default getRequestConfig(async ({ requestLocale }) => {
  const requestedLocale = await requestLocale;
  let locale: Locale = defaultLocale;

  if (requestedLocale && locales.includes(requestedLocale as Locale)) {
    locale = requestedLocale as Locale;
  }

  const [common, dashboard, errors, solicitudes, conversaciones, agenda, contactos, settings, sandbox, webhooks, wabaFlows, variables, tenants, agentes] = await Promise.all([
    import(`../../public/locales/${locale}/common.json`),
    import(`../../public/locales/${locale}/dashboard.json`),
    import(`../../public/locales/${locale}/errors.json`),
    import(`../../public/locales/${locale}/solicitudes.json`),
    import(`../../public/locales/${locale}/conversaciones.json`),
    import(`../../public/locales/${locale}/agenda.json`),
    import(`../../public/locales/${locale}/contactos.json`),
    import(`../../public/locales/${locale}/settings.json`),
    import(`../../public/locales/${locale}/sandbox.json`),
    import(`../../public/locales/${locale}/webhooks.json`),
    import(`../../public/locales/${locale}/wabaFlows.json`),
    import(`../../public/locales/${locale}/variables.json`),
    import(`../../public/locales/${locale}/tenants.json`),
    import(`../../public/locales/${locale}/agentes.json`),
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
      sandbox: sandbox.default,
      webhooks: webhooks.default,
      wabaFlows: wabaFlows.default,
      variables: variables.default,
      tenants: tenants.default,
      agentes: agentes.default,
    },
  };
});
