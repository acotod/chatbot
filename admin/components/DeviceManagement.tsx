import React, { useState, useEffect } from 'react';
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

interface DeviceManagementProps {
  title?: string;
  showTitle?: boolean;
}

/**
 * DeviceManagement Component
 * Allows admins to view and manage their connected devices
 * Phase 2: Enterprise authentication hardening
 */
export default function DeviceManagement({
  title = 'Connected Devices',
  showTitle = true,
}: DeviceManagementProps) {
  const [devices, setDevices] = useState<DeviceSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    fetchDevices();
  }, []);

  const fetchDevices = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await deviceSessionsApi.listAdminDevices();
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
      await deviceSessionsApi.revokeAdminDevice(deviceId);
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

  if (loading) {
    return (
      <div className="p-4 bg-gray-50 rounded-lg">
        {showTitle && <h2 className="text-lg font-semibold mb-4">{title}</h2>}
        <div className="text-center py-8">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
          <p className="mt-2 text-gray-600">Loading devices...</p>
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

      {devices.length === 0 ? (
        <p className="text-gray-500">No connected devices found</p>
      ) : (
        <div className="space-y-3">
          {devices.map((device) => (
            <div key={device.id} className="bg-white p-4 rounded border border-gray-200 flex justify-between items-start">
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
  );
}
