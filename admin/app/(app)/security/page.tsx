'use client';

import React, { useState } from 'react';
import DeviceManagement from '@/components/DeviceManagement';
import MFARecoveryCodes from '@/components/MFARecoveryCodes';

/**
 * Admin Security Settings Page
 * Allows admins to manage connected devices and MFA settings
 * Phase 2: Enterprise authentication hardening
 */
export default function SecuritySettingsPage() {
  const [activeTab, setActiveTab] = useState<'devices' | 'mfa'>('devices');

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">Ajustes de seguridad</h1>
          <p className="mt-2 text-gray-600">
            Administra tus dispositivos conectados, sesiones y la autenticación multifactor
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
            Dispositivos conectados
          </button>
          <button
            onClick={() => setActiveTab('mfa')}
            className={`px-4 py-3 font-medium border-b-2 transition ${
              activeTab === 'mfa'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-600 hover:text-gray-900'
            }`}
          >
            Códigos de recuperación MFA
          </button>
        </div>

        {/* Content */}
        <div className="space-y-6">
          {activeTab === 'devices' && (
            <div>
              <DeviceManagement showTitle={true} />
              <div className="mt-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                <h3 className="font-semibold text-blue-900 mb-2">💡 Recomendaciones de seguridad</h3>
                <ul className="text-sm text-blue-800 space-y-1 list-disc list-inside">
                  <li>Revisa con frecuencia tus dispositivos conectados</li>
                  <li>Revoca de inmediato el acceso de cualquier dispositivo que no reconozcas</li>
                  <li>Si ves actividad sospechosa, cambia tu contraseña y revisa tu cuenta</li>
                  <li>Activa los códigos de recuperación MFA para accesos de emergencia</li>
                </ul>
              </div>
            </div>
          )}

          {activeTab === 'mfa' && (
            <div>
              <MFARecoveryCodes showTitle={true} />
              <div className="mt-6 p-4 bg-green-50 border border-green-200 rounded-lg">
                <h3 className="font-semibold text-green-900 mb-2">✅ Buenas prácticas de MFA</h3>
                <ul className="text-sm text-green-800 space-y-1 list-disc list-inside">
                  <li>Guarda los códigos de recuperación en un gestor de contraseñas seguro</li>
                  <li>Nunca compartas los códigos de recuperación con nadie</li>
                  <li>Genera códigos nuevos periódicamente, por ejemplo cada 3 meses</li>
                  <li>Mantén los códigos separados de la copia de seguridad de tu autenticador</li>
                </ul>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="mt-8 pt-6 border-t border-gray-200 text-center text-sm text-gray-500">
          <p>Última actualización: {new Date().toLocaleDateString()}</p>
          <p className="mt-1">Para asuntos de seguridad, contacta con tu administrador del sistema</p>
        </div>
      </div>
    </div>
  );
}
