'use client';

import React, { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import DeviceManagement from '@/components/DeviceManagement';
import MFARecoveryCodes from '@/components/MFARecoveryCodes';

/**
 * Admin Security Settings Page
 * Allows admins to manage connected devices and MFA settings
 * Phase 2: Enterprise authentication hardening
 */
export default function SecuritySettingsPage() {
  const t = useTranslations('security');
  const locale = useLocale();
  const [activeTab, setActiveTab] = useState<'devices' | 'mfa'>('devices');

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">{t('admin.header.title')}</h1>
          <p className="mt-2 text-gray-600">
            {t('admin.header.description')}
          </p>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-200 mb-6">
          <button
            onClick={() => setActiveTab('devices')}
            className={`px-4 py-3 font-medium border-b-2 transition ${
              activeTab === 'devices'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-600 hover:text-gray-900'
            }`}
          >
            {t('admin.tabs.devices')}
          </button>
          <button
            onClick={() => setActiveTab('mfa')}
            className={`px-4 py-3 font-medium border-b-2 transition ${
              activeTab === 'mfa'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-600 hover:text-gray-900'
            }`}
          >
            {t('admin.tabs.mfa')}
          </button>
        </div>

        {/* Content */}
        <div className="space-y-6">
          {activeTab === 'devices' && (
            <div>
              <DeviceManagement showTitle={true} />
              <div className="mt-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                <h3 className="font-semibold text-blue-900 mb-2">{t('admin.deviceTips.title')}</h3>
                <ul className="text-sm text-blue-800 space-y-1 list-disc list-inside">
                  <li>{t('admin.deviceTips.item1')}</li>
                  <li>{t('admin.deviceTips.item2')}</li>
                  <li>{t('admin.deviceTips.item3')}</li>
                  <li>{t('admin.deviceTips.item4')}</li>
                </ul>
              </div>
            </div>
          )}

          {activeTab === 'mfa' && (
            <div>
              <MFARecoveryCodes showTitle={true} />
              <div className="mt-6 p-4 bg-green-50 border border-green-200 rounded-lg">
                <h3 className="font-semibold text-green-900 mb-2">{t('admin.mfaTips.title')}</h3>
                <ul className="text-sm text-green-800 space-y-1 list-disc list-inside">
                  <li>{t('admin.mfaTips.item1')}</li>
                  <li>{t('admin.mfaTips.item2')}</li>
                  <li>{t('admin.mfaTips.item3')}</li>
                  <li>{t('admin.mfaTips.item4')}</li>
                </ul>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="mt-8 pt-6 border-t border-gray-200 text-center text-sm text-gray-500">
          <p>
            {t('admin.footer.lastUpdate', {
              date: new Date().toLocaleDateString(locale),
            })}
          </p>
          <p className="mt-1">{t('admin.footer.contact')}</p>
        </div>
      </div>
    </div>
  );
}
