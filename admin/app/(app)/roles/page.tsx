"use client";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { rbacApi, tenantApi } from "@/lib/api";
import { getMe } from "@/lib/useMe";
import { getStoredAccessToken, useAuthStore } from "@/store/auth";
import { Plus, Trash2, Shield, Users, Pencil } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import axios from "axios";

interface Permiso { id: number; clave: string; }
interface Role { id: number; nombre: string; tenantId: string | null; permisos: { permiso: Permiso }[]; }
interface Tenant { id: string; slug: string; nombre: string; }
interface AdminUser { id: number; email: string; nombre: string; superAdmin: boolean; tenantId: string | null; roles: { role: { id: number; nombre: string } }[]; }

function getAssignableRoles(roles: Role[], isTenantAdmin: boolean, tenantId: string): Role[] {
  if (isTenantAdmin) {
    return roles.filter((r) => r.tenantId === tenantId);
  }
  if (!tenantId) {
    return roles.filter((r) => r.tenantId === null);
  }
  return roles.filter((r) => r.tenantId === null || r.tenantId === tenantId);
}

export default function RolesPage() {
  const qc = useQueryClient();
  const me = getMe();
  const hasAccessToken = Boolean(getStoredAccessToken());
  const isTenantAdmin = !me?.superAdmin && !!me?.tenantId;
  const { permissions } = useAuthStore();
  const canManageRoles = me?.superAdmin || (permissions ?? []).includes("MANAGE_ROLES");
  const canManageUsers = me?.superAdmin || canManageRoles || (permissions ?? []).includes("MANAGE_USERS");
  // Users-only managers start on the users tab and cannot navigate to roles tab
  const [tab, setTab] = useState<"roles" | "users">(canManageRoles ? "roles" : "users");
  const [showRoleModal, setShowRoleModal] = useState(false);
  const [showUserModal, setShowUserModal] = useState(false);
  const [editingRole, setEditingRole] = useState<Role | null>(null);
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);

  const { data: permisos = [] } = useQuery<Permiso[]>({
    queryKey: ["permisos"],
    queryFn: () => rbacApi.listPermisos().then((r) => r.data),
  });

  const { data: roles = [], isLoading: loadingRoles } = useQuery<Role[]>({
    queryKey: ["roles"],
    queryFn: () => rbacApi.listRoles().then((r) => r.data),
  });

  const { data: users = [], isLoading: loadingUsers } = useQuery<AdminUser[]>({
    queryKey: ["adminUsers"],
    queryFn: () => rbacApi.listUsers().then((r) => r.data),
  });

  const { data: tenants = [] } = useQuery<Tenant[]>({
    queryKey: ["tenants"],
    queryFn: () => tenantApi.list().then((r) => r.data),
    enabled: hasAccessToken,
  });

  const deleteRole = useMutation({
    mutationFn: (id: number) => rbacApi.deleteRole(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["roles"] }),
  });

  const deleteUser = useMutation({
    mutationFn: (id: number) => rbacApi.deleteUser(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["adminUsers"] }),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Roles y Accesos</h1>
          <p className="text-sm text-gray-500 mt-1">
            {canManageRoles ? "Control granular de permisos (RBAC)" : "Gestión de usuarios admin"}
          </p>
        </div>
        {(tab === "users" ? canManageUsers : canManageRoles) && (
          <button
            onClick={() => (tab === "roles" ? setShowRoleModal(true) : setShowUserModal(true))}
            className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700 transition"
          >
            <Plus className="w-4 h-4" />
            {tab === "roles" ? "Nuevo rol" : "Nuevo usuario"}
          </button>
        )}
      </div>

      {/* Tabs */}
      {canManageRoles && (
        <div className="flex border-b">
          {(["roles", "users"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ${
                tab === t
                  ? "border-blue-600 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {t === "roles" ? (
                <span className="flex items-center gap-2"><Shield className="w-4 h-4" />Roles</span>
              ) : (
                <span className="flex items-center gap-2"><Users className="w-4 h-4" />Usuarios admin</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Roles */}
      {tab === "roles" && (
        <div className="grid gap-4">
          {loadingRoles
            ? Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-24 bg-gray-100 rounded-xl animate-pulse" />
              ))
            : roles.map((role) => (
                <div key={role.id} className="bg-white rounded-xl border p-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="font-semibold text-gray-900">{role.nombre}</h3>
                      <p className="text-xs text-gray-400 mt-1">
                        {role.tenantId ? `Tenant: ${role.tenantId}` : "Global"}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setEditingRole(role)}
                        className="text-gray-400 hover:text-blue-500 transition p-1"
                        title="Editar rol"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => deleteRole.mutate(role.id)}
                        className="text-gray-400 hover:text-red-500 transition p-1"
                        title="Eliminar rol"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 mt-3">
                    {role.permisos.map(({ permiso }) => (
                      <span
                        key={permiso.id}
                        className="text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded font-mono"
                      >
                        {permiso.clave}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
        </div>
      )}

      {/* Admin users */}
      {tab === "users" && (
        <div className="bg-white rounded-xl border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Nombre</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Correo electrónico</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Empresa</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Roles</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Tipo</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loadingUsers
                ? Array.from({ length: 3 }).map((_, i) => (
                    <tr key={i}>
                      {Array.from({ length: 6 }).map((__, j) => (
                        <td key={j} className="px-4 py-3">
                          <div className="h-4 bg-gray-100 rounded animate-pulse" />
                        </td>
                      ))}
                    </tr>
                  ))
                : users.filter((u) => !isTenantAdmin || !u.superAdmin).map((u) => (
                    <tr key={u.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium text-gray-900">{u.nombre}</td>
                      <td className="px-4 py-3 text-gray-600">{u.email}</td>
                      <td className="px-4 py-3 text-gray-600 text-xs">
                        {u.tenantId
                          ? <span className="bg-blue-50 text-blue-700 px-2 py-0.5 rounded font-mono">{u.tenantId}</span>
                          : <span className="text-gray-400">—</span>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {u.roles.map(({ role }) => (
                            <span key={role.id} className="text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded">
                              {role.nombre}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {u.superAdmin ? (
                          <span className="text-xs bg-purple-100 text-purple-700 px-2 py-1 rounded font-medium">
                            Superadministrador
                          </span>
                        ) : (
                          <span className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded">
                            Administrador
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => setEditingUser(u)}
                            className="text-gray-400 hover:text-blue-500 transition"
                            title="Editar usuario"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => deleteUser.mutate(u.id)}
                            className="text-gray-400 hover:text-red-500 transition"
                            title="Eliminar usuario"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create Role Modal */}
      <CreateRoleModal
        open={showRoleModal}
        permisos={permisos}
        onClose={() => setShowRoleModal(false)}
        onCreated={() => { setShowRoleModal(false); qc.invalidateQueries({ queryKey: ["roles"] }); }}
      />

      {/* Edit Role Modal */}
      {editingRole && (
        <EditRoleModal
          open={!!editingRole}
          role={editingRole}
          permisos={permisos}
          onClose={() => setEditingRole(null)}
          onSaved={() => { setEditingRole(null); qc.invalidateQueries({ queryKey: ["roles"] }); }}
        />
      )}

      {/* Create User Modal */}
      <CreateUserModal
        open={showUserModal}
        roles={roles}
        tenants={tenants}
        isTenantAdmin={isTenantAdmin}
        callerTenantId={me?.tenantId ?? null}
        canManageRoles={canManageRoles}
        onClose={() => setShowUserModal(false)}
        onCreated={() => { setShowUserModal(false); qc.invalidateQueries({ queryKey: ["adminUsers"] }); }}
      />

      {/* Edit User Modal */}
      {editingUser && (
        <EditUserModal
          open={!!editingUser}
          user={editingUser}
          roles={roles}
          tenants={tenants}
          isTenantAdmin={isTenantAdmin}
          callerTenantId={me?.tenantId ?? null}
          canManageRoles={canManageRoles}
          onClose={() => setEditingUser(null)}
          onSaved={() => { setEditingUser(null); qc.invalidateQueries({ queryKey: ["adminUsers"] }); }}
        />
      )}
    </div>
  );
}

function CreateRoleModal({
  open, permisos, onClose, onCreated,
}: {
  open: boolean;
  permisos: Permiso[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [nombre, setNombre] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function handleSubmit() {
    if (!nombre.trim()) return;
    setLoading(true);
    try {
      await rbacApi.createRole({ nombre: nombre.trim(), permisoIds: [...selected] });
      onCreated();
      setNombre(""); setSelected(new Set());
    } finally { setLoading(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Nuevo rol">
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Nombre</label>
          <input
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Ej: Supervisor"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Permisos</label>
          <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto">
            {permisos.map((p) => (
              <label key={p.id} className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={selected.has(p.id)}
                  onChange={() => toggle(p.id)}
                  className="rounded"
                />
                <span className="font-mono text-xs text-gray-700">{p.clave}</span>
              </label>
            ))}
          </div>
        </div>
        <button
          onClick={handleSubmit}
          disabled={loading || !nombre.trim()}
          className="w-full bg-blue-600 text-white py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50 transition"
        >
          {loading ? "Creando…" : "Crear rol"}
        </button>
      </div>
    </Modal>
  );
}

function CreateUserModal({
  open, roles, tenants, isTenantAdmin, callerTenantId, canManageRoles, onClose, onCreated,
}: {
  open: boolean;
  roles: Role[];
  tenants: Tenant[];
  isTenantAdmin: boolean;
  callerTenantId: string | null;
  canManageRoles: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({ nombre: "", email: "", password: "" });
  const [tenantId, setTenantId] = useState<string>(callerTenantId ?? "");
  const [selectedRoles, setSelectedRoles] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const tenantNameById = useMemo(() => {
    const map = new Map<string, string>();
    tenants.forEach((t) => map.set(t.id, `${t.nombre} (${t.slug})`));
    return map;
  }, [tenants]);
  const allowedRoles = useMemo(
    () => getAssignableRoles(roles, isTenantAdmin, tenantId),
    [roles, isTenantAdmin, tenantId]
  );

  useEffect(() => {
    const allowedIds = new Set(allowedRoles.map((r) => r.id));
    setSelectedRoles((prev) => {
      const next = new Set([...prev].filter((id) => allowedIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [allowedRoles]);

  function toggleRole(id: number) {
    setSelectedRoles((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function handleSubmit() {
    if (!form.nombre || !form.email || !form.password) {
      setError("Todos los campos son obligatorios");
      return;
    }
    setLoading(true); setError("");
    try {
      if (canManageRoles && selectedRoles.size === 0) {
        setError("Selecciona al menos un rol");
        setLoading(false);
        return;
      }
      await rbacApi.createUser({
        ...form,
        tenantId: tenantId || null,
        roleIds: canManageRoles ? [...selectedRoles] : [],
      });
      onCreated();
      setForm({ nombre: "", email: "", password: "" });
      setTenantId(callerTenantId ?? "");
      setSelectedRoles(new Set());
    } catch (err) {
      if (axios.isAxiosError(err)) {
        setError(String(err.response?.data?.error || "No se pudo crear el usuario"));
      } else {
        setError("No se pudo crear el usuario");
      }
    } finally { setLoading(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Nuevo usuario admin">
      <div className="space-y-4">
        {(["nombre", "email", "password"] as const).map((field) => (
          <div key={field}>
            <label className="block text-sm font-medium text-gray-700 mb-1 capitalize">
              {field}
            </label>
            <input
              type={field === "password" ? "password" : "text"}
              value={form[field]}
              onChange={(e) => setForm((p) => ({ ...p, [field]: e.target.value }))}
              className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        ))}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Tenant</label>
          {isTenantAdmin ? (
            <p className="text-sm text-gray-700 bg-gray-50 border rounded-lg px-3 py-2">
              {tenantId && tenantNameById.get(tenantId)
                ? tenantNameById.get(tenantId)
                : callerTenantId}
              <span className="text-gray-400 text-xs"> (fijo a tu tenant)</span>
            </p>
          ) : (
            <select
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">— Sin tenant (global) —</option>
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>{t.nombre} ({t.slug})</option>
              ))}
            </select>
          )}
        </div>
        <div>
          {canManageRoles && (
            <>
              <label className="block text-sm font-medium text-gray-700 mb-2">Roles</label>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {allowedRoles.map((r) => (
                  <label key={r.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedRoles.has(r.id)}
                      onChange={() => toggleRole(r.id)}
                      className="rounded"
                    />
                    {r.nombre}
                  </label>
                ))}
                {allowedRoles.length === 0 && (
                  <p className="text-xs text-gray-400">No hay roles disponibles para el tenant seleccionado.</p>
                )}
              </div>
            </>
          )}
        </div>
        {error && <p className="text-sm text-red-500">{error}</p>}
        <button
          onClick={handleSubmit}
          disabled={loading}
          className="w-full bg-blue-600 text-white py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50 transition"
        >
          {loading ? "Creando…" : "Crear usuario"}
        </button>
      </div>
    </Modal>
  );
}

// ── Edit Role ──────────────────────────────────────────────────────────────────

function EditRoleModal({
  open, role, permisos, onClose, onSaved,
}: {
  open: boolean;
  role: Role;
  permisos: Permiso[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [nombre, setNombre] = useState(role.nombre);
  const [selected, setSelected] = useState<Set<number>>(
    new Set(role.permisos.map(({ permiso }) => permiso.id))
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function handleSubmit() {
    if (!nombre.trim()) return;
    setLoading(true); setError("");
    try {
      await rbacApi.updateRole(role.id, { nombre: nombre.trim(), permisoIds: [...selected] });
      onSaved();
    } catch {
      setError("No se pudo actualizar el rol");
    } finally { setLoading(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Editar rol">
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Nombre</label>
          <input
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Permisos</label>
          <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto">
            {permisos.map((p) => (
              <label key={p.id} className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={selected.has(p.id)}
                  onChange={() => toggle(p.id)}
                  className="rounded"
                />
                <span className="font-mono text-xs text-gray-700">{p.clave}</span>
              </label>
            ))}
          </div>
        </div>
        {error && <p className="text-sm text-red-500">{error}</p>}
        <button
          onClick={handleSubmit}
          disabled={loading || !nombre.trim()}
          className="w-full bg-blue-600 text-white py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50 transition"
        >
          {loading ? "Guardando…" : "Guardar cambios"}
        </button>
      </div>
    </Modal>
  );
}

// ── Edit User ──────────────────────────────────────────────────────────────────

function EditUserModal({
  open, user, roles, tenants, isTenantAdmin, callerTenantId, canManageRoles, onClose, onSaved,
}: {
  open: boolean;
  user: AdminUser;
  roles: Role[];
  tenants: Tenant[];
  isTenantAdmin: boolean;
  callerTenantId: string | null;
  canManageRoles: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({ nombre: user.nombre, email: user.email, password: "" });
  const [tenantId, setTenantId] = useState<string>(user.tenantId ?? "");
  const [selectedRoles, setSelectedRoles] = useState<Set<number>>(
    new Set(user.roles.map(({ role }) => role.id))
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const tenantNameById = useMemo(() => {
    const map = new Map<string, string>();
    tenants.forEach((t) => map.set(t.id, `${t.nombre} (${t.slug})`));
    return map;
  }, [tenants]);
  const allowedRoles = useMemo(
    () => getAssignableRoles(roles, isTenantAdmin, tenantId),
    [roles, isTenantAdmin, tenantId]
  );

  useEffect(() => {
    const allowedIds = new Set(allowedRoles.map((r) => r.id));
    setSelectedRoles((prev) => {
      const next = new Set([...prev].filter((id) => allowedIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [allowedRoles]);

  function toggleRole(id: number) {
    setSelectedRoles((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function handleSubmit() {
    if (!form.nombre || !form.email) {
      setError("Nombre y email son obligatorios");
      return;
    }
    setLoading(true); setError("");
    try {
      if (canManageRoles && selectedRoles.size === 0) {
        setError("Selecciona al menos un rol");
        setLoading(false);
        return;
      }
      const payload: Record<string, unknown> = {
        nombre: form.nombre,
        email: form.email,
        tenantId: tenantId || null,
        ...(canManageRoles ? { roleIds: [...selectedRoles] } : {}),
      };
      if (form.password) payload.password = form.password;
      await rbacApi.updateUser(user.id, payload);
      onSaved();
    } catch {
      setError("No se pudo actualizar el usuario");
    } finally { setLoading(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Editar usuario admin">
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Nombre</label>
          <input
            value={form.nombre}
            onChange={(e) => setForm((p) => ({ ...p, nombre: e.target.value }))}
            className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
          <input
            type="email"
            value={form.email}
            onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
            className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Nueva contraseña <span className="text-gray-400 font-normal">(dejar vacío para no cambiar)</span>
          </label>
          <input
            type="password"
            value={form.password}
            onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))}
            className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="••••••••"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Tenant</label>
          {isTenantAdmin ? (
            <p className="text-sm text-gray-700 bg-gray-50 border rounded-lg px-3 py-2">
              {tenantId && tenantNameById.get(tenantId)
                ? tenantNameById.get(tenantId)
                : callerTenantId}
              <span className="text-gray-400 text-xs"> (fijo a tu tenant)</span>
            </p>
          ) : (
            <>
              <select
                value={tenantId}
                onChange={(e) => setTenantId(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">— Sin tenant (global) —</option>
                {tenants.map((t) => (
                  <option key={t.id} value={t.id}>{t.nombre} ({t.slug})</option>
                ))}
              </select>
              {!user.superAdmin && (
                <p className="text-xs text-gray-400 mt-1">Un usuario no-superAdmin solo puede pertenecer a un tenant.</p>
              )}
            </>
          )}
        </div>
        <div>
          {canManageRoles ? (
            <>
              <label className="block text-sm font-medium text-gray-700 mb-2">Roles</label>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {allowedRoles.map((r) => (
                  <label key={r.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedRoles.has(r.id)}
                      onChange={() => toggleRole(r.id)}
                      className="rounded"
                    />
                    {r.nombre}
                  </label>
                ))}
                {allowedRoles.length === 0 && (
                  <p className="text-xs text-gray-400">No hay roles disponibles para el tenant seleccionado.</p>
                )}
              </div>
            </>
          ) : (
            <div>
              <p className="text-xs text-gray-500 font-medium mb-1">Roles asignados</p>
              <div className="space-y-1">
                {user.roles.length === 0 ? (
                  <p className="text-xs text-gray-400">Sin roles asignados</p>
                ) : user.roles.map(({ role }) => (
                  <span key={role.id} className="inline-block text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded mr-1">{role.nombre}</span>
                ))}
              </div>
              <p className="text-xs text-gray-400 mt-1">No tienes permiso para cambiar roles.</p>
            </div>
          )}
        </div>
        {error && <p className="text-sm text-red-500">{error}</p>}
        <button
          onClick={handleSubmit}
          disabled={loading}
          className="w-full bg-blue-600 text-white py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50 transition"
        >
          {loading ? "Guardando…" : "Guardar cambios"}
        </button>
      </div>
    </Modal>
  );
}
