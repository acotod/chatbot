'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import axios from 'axios';
import { deviceSessionsApi } from '@/lib/api';

interface DeviceSession {
  id: string;
  deviceName: string;
  ipAddress: string;
  lastSeenAt: string;
  isActive: boolean;
}

/**
 * Agent Security Settings Page
 * Allows agents to manage their connected devices and sessions
 * Phase 2: Enterprise authentication hardening
 */
export default function AgentSecuritySettingsPage() {
  const [devices, setDevices] = useState<DeviceSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const router = useRouter();

  React.useEffect(() => {
    fetchDevices();
  }, []);

  const fetchDevices = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await deviceSessionsApi.listAgentDevices();
      setDevices(response.data.sessions || []);
    } catch (err: any) {
      if (axios.isCancel(err) || err?.code === 'ERR_CANCELED') {
        return;
      }
      console.error('Error fetching devices:', err);
      setError(err.response?.data?.error || 'Failed to load devices');
    } finally {
      setLoading(false);
    }
  };

  const handleRevokeDevice = async (deviceId: string, deviceName: string) => {
    if (!confirm(`Are you sure you want to revoke access from "${deviceName}"? You'll need to log in again on that device.`)) {
      return;
    }

    try {
      setRevoking(deviceId);
      await deviceSessionsApi.revokeAgentDevice(deviceId);
      setDevices(devices.filter(d => d.id !== deviceId));
      alert('Device session revoked successfully');
    } catch (err: any) {
      if (axios.isCancel(err) || err?.code === 'ERR_CANCELED') {
        return;
      }
      console.error('Error revoking device:', err);
      setError(err.response?.data?.error || 'Failed to revoke device session');
    } finally {
      setRevoking(null);
    }
  };

  const formatDate = (dateString: string) => {
    try {
      return new Date(dateString).toLocaleString();
    } catch {
      return dateString;
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">Security Settings</h1>
          <p className="mt-2 text-gray-600">
            Manage your connected devices and active sessions
          </p>
        </div>

        {/* Connected Devices Section */}
        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <h2 className="text-xl font-semibold mb-4 text-gray-900">Connected Devices</h2>

          {error && (
            <div className="mb-4 p-3 bg-red-100 border border-red-400 text-red-700 rounded">
              {error}
            </div>
          )}

          {loading ? (
            <div className="text-center py-8">
              <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
              <p className="mt-2 text-gray-600">Loading devices...</p>
            </div>
          ) : devices.length === 0 ? (
            <p className="text-gray-500">No connected devices found</p>
          ) : (
            <div className="space-y-3">
              {devices.map((device) => (
                <div key={device.id} className="bg-gray-50 p-4 rounded border border-gray-200 flex justify-between items-start">
                  <div className="flex-1">
                    <div className="font-semibold text-gray-900">{device.deviceName}</div>
                    <div className="text-sm text-gray-600 mt-1">
                      <div>IP: {device.ipAddress}</div>
                      <div>Last seen: {formatDate(device.lastSeenAt)}</div>
                    </div>
                  </div>
                  <button
                    onClick={() => handleRevokeDevice(device.id, device.deviceName)}
                    disabled={revoking === device.id}
                    className={`ml-4 px-3 py-2 rounded text-white text-sm transition ${
                      revoking === device.id
                        ? 'bg-gray-400 cursor-not-allowed'
                        : 'bg-red-600 hover:bg-red-700'
                    }`}
                  >
                    {revoking === device.id ? 'Revoking...' : 'Revoke'}
                  </button>
                </div>
              ))}
            </div>
          )}

          <button
            onClick={fetchDevices}
            className="mt-4 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition"
          >
            Refresh
          </button>
        </div>

        {/* Security Tips */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-6">
          <h3 className="font-semibold text-blue-900 mb-2">💡 Device Security Tips</h3>
          <ul className="text-sm text-blue-800 space-y-2 list-disc list-inside">
            <li>Regularly review your connected devices</li>
            <li>Revoke access from any unrecognized devices immediately</li>
            <li>Log out of devices when you're not using them</li>
            <li>Report suspicious activity to your administrator</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
