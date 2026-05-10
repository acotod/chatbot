import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { deviceSessionsApi } from '@/lib/api';

interface MFARecoveryCodesProps {
  title?: string;
  showTitle?: boolean;
}

/**
 * MFARecoveryCodes Component
 * Allows admins to generate and manage MFA recovery codes
 * Phase 2: Enterprise authentication hardening
 */
export default function MFARecoveryCodes({
  title = 'Códigos de recuperación MFA',
  showTitle = true,
}: MFARecoveryCodesProps) {
  const [unusedCount, setUnusedCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatedCodes, setGeneratedCodes] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetchRecoveryCodesCount();
  }, []);

  const fetchRecoveryCodesCount = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await deviceSessionsApi.getRecoveryCodesCount();
      setUnusedCount(response.data.unusedCodeCount || 0);
    } catch (err: any) {
      console.error('Error fetching recovery codes count:', err);
      setError(err.response?.data?.error || 'No se pudieron cargar los códigos de recuperación');
    } finally {
      setLoading(false);
    }
  };

  const handleGenerateNewCodes = async () => {
    if (!confirm('¿Seguro que quieres generar nuevos códigos de recuperación? Los códigos anteriores dejarán de ser válidos. Asegúrate de guardar los nuevos en un lugar seguro.')) {
      return;
    }

    try {
      setGenerating(true);
      setError(null);
      const response = await deviceSessionsApi.generateRecoveryCodes();
      setGeneratedCodes(response.data.codes || []);
      setUnusedCount(response.data.codes?.length || 0);
    } catch (err: any) {
      console.error('Error generating recovery codes:', err);
      setError(err.response?.data?.error || 'No se pudieron generar los códigos de recuperación');
    } finally {
      setGenerating(false);
    }
  };

  const handleCopyCodes = () => {
    const codesText = generatedCodes.join('\n');
    navigator.clipboard.writeText(codesText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) {
    return (
      <div className="p-4 bg-gray-50 rounded-lg">
        {showTitle && <h2 className="text-lg font-semibold mb-4">{title}</h2>}
        <div className="text-center py-8">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
          <p className="mt-2 text-gray-600">Cargando códigos de recuperación...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 bg-gray-50 rounded-lg">
      {showTitle && <h2 className="text-lg font-semibold mb-4">{title}</h2>}

      {error && (
        <div className="mb-4 p-3 bg-red-100 border border-red-400 text-red-700 rounded">
          {error}
        </div>
      )}

      {/* Recovery Codes Status */}
      <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded">
        <p className="text-sm text-gray-700">
          <strong>Códigos de recuperación sin usar:</strong> {unusedCount}
        </p>
        {unusedCount < 3 && unusedCount > 0 && (
          <p className="text-sm text-orange-600 mt-1">
            ⚠️ Quedan pocos códigos de recuperación. Considera generar nuevos.
          </p>
        )}
        {unusedCount === 0 && (
          <p className="text-sm text-red-600 mt-1">
            ⚠️ No hay códigos de recuperación disponibles. Genera nuevos ahora.
          </p>
        )}
      </div>

      {/* Generated Codes Display */}
      {generatedCodes.length > 0 && (
        <div className="mb-4 p-4 bg-yellow-50 border border-yellow-200 rounded">
          <p className="text-sm font-semibold text-yellow-900 mb-2">
            🔒 Guarda estos códigos en un lugar seguro. No se volverán a mostrar.
          </p>
          <div className="bg-white p-3 rounded font-mono text-sm mb-3">
            {generatedCodes.map((code, idx) => (
              <div key={idx} className="text-gray-700">
                {code}
              </div>
            ))}
          </div>
          <button
            onClick={handleCopyCodes}
            className={`px-3 py-2 rounded text-sm transition ${
              copied
                ? 'bg-green-600 text-white'
                : 'bg-yellow-600 text-white hover:bg-yellow-700'
            }`}
          >
            {copied ? '✓ Copiados' : 'Copiar códigos'}
          </button>
        </div>
      )}

      {/* Generate New Codes Button */}
      <button
        onClick={handleGenerateNewCodes}
        disabled={generating}
        className={`w-full px-4 py-2 rounded text-white transition ${
          generating
            ? 'bg-gray-400 cursor-not-allowed'
            : 'bg-blue-600 hover:bg-blue-700'
        }`}
      >
        {generating ? 'Generando...' : 'Generar nuevos códigos de recuperación'}
      </button>

      {/* Information Section */}
      <div className="mt-4 p-3 bg-gray-100 rounded text-sm text-gray-700">
        <p className="font-semibold mb-2">¿Qué son los códigos de recuperación?</p>
        <ul className="list-disc list-inside space-y-1 text-xs">
          <li>Códigos de un solo uso para acceder en caso de emergencia si pierdes tu autenticador</li>
          <li>Cada código solo puede usarse una vez</li>
          <li>Guárdalos en un lugar seguro y cifrado</li>
          <li>Nunca compartas tus códigos de recuperación con nadie</li>
        </ul>
      </div>
    </div>
  );
}
