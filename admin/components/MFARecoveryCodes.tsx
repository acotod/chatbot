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
  title = 'MFA Recovery Codes',
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
      setError(err.response?.data?.error || 'Failed to load recovery codes');
    } finally {
      setLoading(false);
    }
  };

  const handleGenerateNewCodes = async () => {
    if (!confirm('Are you sure you want to generate new recovery codes? Old codes will be invalidated. Make sure to save the new codes in a secure location.')) {
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
      setError(err.response?.data?.error || 'Failed to generate recovery codes');
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
          <p className="mt-2 text-gray-600">Loading recovery codes...</p>
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
          <strong>Unused Recovery Codes:</strong> {unusedCount}
        </p>
        {unusedCount < 3 && unusedCount > 0 && (
          <p className="text-sm text-orange-600 mt-1">
            ⚠️ Running low on recovery codes. Consider generating new ones.
          </p>
        )}
        {unusedCount === 0 && (
          <p className="text-sm text-red-600 mt-1">
            ⚠️ No recovery codes available. Generate new ones now.
          </p>
        )}
      </div>

      {/* Generated Codes Display */}
      {generatedCodes.length > 0 && (
        <div className="mb-4 p-4 bg-yellow-50 border border-yellow-200 rounded">
          <p className="text-sm font-semibold text-yellow-900 mb-2">
            🔒 Save these codes in a secure location. They will not be shown again!
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
            {copied ? '✓ Copied' : 'Copy Codes'}
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
        {generating ? 'Generating...' : 'Generate New Recovery Codes'}
      </button>

      {/* Information Section */}
      <div className="mt-4 p-3 bg-gray-100 rounded text-sm text-gray-700">
        <p className="font-semibold mb-2">What are recovery codes?</p>
        <ul className="list-disc list-inside space-y-1 text-xs">
          <li>One-time use codes for emergency access if you lose your authenticator</li>
          <li>Each code can only be used once</li>
          <li>Store them in a secure, encrypted location</li>
          <li>Never share your recovery codes with anyone</li>
        </ul>
      </div>
    </div>
  );
}
