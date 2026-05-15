"use client";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { rbacApi, tenantApi } from "@/lib/api";
import { getMe } from "@/lib/useMe";
import { getStoredAccessToken, useAuthStore } from "@/store/auth";
import { Plus, Trash2, Shield, Users, Pencil } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import axios from "axios";
import { useTranslations } from "next-intl";

interface Permiso { id: number; clave: string; }
interface Role { id: number; nombre: string; tenantId: string | null; permisos: { permiso: Permiso }[]; }
interface Tenant { id: string; slug: string; nombre: string; }
interface AdminUser { id: number; email: string; nombre: string; superAdmin: boolean; tenantId: string | null; roles: { role: { id: number; nombre: string } }[]; }
type RolesViewTab = "roles" | "users";

interface RolesAccessPageProps {
  initialTab?: RolesViewTab;
  lockToUsers?: boolean;
}

function getAssignableRoles(roles: Role[], isTenantAdmin: boolean, tenantId: string): Role[] {
  if (isTenantAdmin) {
    return roles.filter((r) => r.tenantId === tenantId);
  }
  if (!tenantId) {
    return roles.filter((r) => r.tenantId === null);
  }
  return roles.filter((r) => r.tenantId === null || r.tenantId === tenantId);
}

function RolesAccessPage({ initialTab = "roles", lockToUsers = false }: RolesAccessPageProps) {
  const qc = useQueryClient();
  const me = getMe();
  const hasAccessToken = Boolean(getStoredAccessToken());
  const isTenantAdmin = !me?.superAdmin && !!me?.tenantId;
  const { permissions } = useAuthStore();
  const canManageRoles = me?.superAdmin || (permissions ?? []).includes("MANAGE_ROLES");
  const canManageUsers = me?.superAdmin || canManageRoles || (permissions ?? []).includes("MANAGE_USERS");
  const t = useTranslations("roles");
  const [tab, setTab] = useState<RolesViewTab>(initialTab);
  const [showRoleModal, setShowRoleModal] = useState(false);
  const [showUserModal, setShowUserModal] = useState(false);
  const [editingRole, setEditingRole] = useState<Role | null>(null);
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);

  const { data: permisos = [] } = useQuery<Permiso[]>({
    queryKey: ["permisos"],
    queryFn: () => rbacApi.listPermisos().then((r) => r.data),
    enabled: hasAccessToken,
  });

  const { data: roles = [], isLoading: loadingRoles } = useQuery<Role[]>({
    queryKey: ["roles"],
    queryFn: () => rbacApi.listRoles().then((r) => r.data),
    enabled: hasAccessToken,
  });

  useEffect(() => {
    if (lockToUsers || initialTab === "users") {
      setTab("users");
      return;
    }
    setTab("roles");
  }, [initialTab, lockToUsers]);

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

  const isUsersView = tab === "users" || lockToUsers;
  const canCreateCurrentTab = tab === "users" ? canManageUsers : canManageRoles;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">{isUsersView ? t("titleUsers") : t("title")}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {isUsersView ? t("subtitleUsers") : t("subtitle")}
          </p>
        </div>
        <button
          type="button"
          onClick={canCreateCurrentTab ? () => (tab === "roles" ? setShowRoleModal(true) : setShowUserModal(true)) : undefined}
          disabled={!canCreateCurrentTab}
          title={!canCreateCurrentTab ? t("noCreatePermission") : undefined}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition ${
            canCreateCurrentTab
              ? "bg-blue-600 text-white hover:bg-blue-700"
              : "bg-gray-200 text-gray-500 cursor-not-allowed"
          }`}
        >
          <Plus className="w-4 h-4" />
          {tab === "roles" ? t("newRole") : t("newUser")}
        </button>
      </div>

      {/* Tabs */}
      {canManageRoles && !lockToUsers && (
        <div className="flex border-b">
          {(["roles", "users"] as const).map((tabKey) => (
            <button
              key={tabKey}
              onClick={() => setTab(tabKey)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ${
                tab === tabKey
                  ? "border-blue-600 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {tabKey === "roles" ? (
                <span className="flex items-center gap-2"><Shield className="w-4 h-4" />{t("tabRoles")}</span>
              ) : (
                <span className="flex items-center gap-2"><Users className="w-4 h-4" />{t("tabUsers")}</span>
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
                        {role.tenantId ? `Tenant: ${role.tenantId}` : t("global")}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setEditingRole(role)}
                        className="text-gray-400 hover:text-blue-500 transition p-1"
                        title={t("editRole")}
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => deleteRole.mutate(role.id)}
                        className="text-gray-400 hover:text-red-500 transition p-1"
                        title={t("deleteRole")}
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
                <th className="px-4 py-3 text-left font-medium text-gray-600">{t("colName")}</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">{t("colEmail")}</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">{t("colCompany")}</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">{t("colRoles")}</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">{t("colType")}</th>
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
                            {t("superAdmin")}
                          </span>
                        ) : (
                          <span className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded">
                            {t("admin")}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => setEditingUser(u)}
                            className="text-gray-400 hover:text-blue-500 transition"
                            title={t("editUser")}
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => deleteUser.mutate(u.id)}
                            className="text-gray-400 hover:text-red-500 transition"
                            title={t("deleteUser")}
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
      {canManageRoles && (
        <CreateRoleModal
          open={showRoleModal}
          permisos={permisos}
          onClose={() => setShowRoleModal(false)}
          onCreated={() => { setShowRoleModal(false); qc.invalidateQueries({ queryKey: ["roles"] }); }}
        />
      )}

      {/* Edit Role Modal */}
      {canManageRoles && editingRole && (
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

export default function RolesPage() {
  return <RolesAccessPage initialTab="roles" />;
}

export function AdminUsersPage() {
  return <RolesAccessPage initialTab="users" lockToUsers />;
}

function CreateRoleModal({
  open, permisos, onClose, onCreated,
}: {
  open: boolean;
  permisos: Permiso[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const t = useTranslations("roles");
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
    <Modal open={open} onClose={onClose} title={t("newRole")}>
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t("fieldName")}</label>
          <input
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder={t("rolePlaceholder")}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">{t("fieldPermissions")}</label>
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
          {loading ? t("creating") : t("createRole")}
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
  const t = useTranslations("roles");
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
      setError(t("errRequired"));
      return;
    }
    setLoading(true); setError("");
    try {
      if (canManageRoles && selectedRoles.size === 0) {
        setError(t("errRoleRequired"));
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
        setError(String(err.response?.data?.error || t("errCreateUser")));
      } else {
        setError(t("errCreateUser"));
      }
    } finally { setLoading(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={t("createUserTitle")}>
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
          <label className="block text-sm font-medium text-gray-700 mb-1">{t("fieldTenant")}</label>
          {isTenantAdmin ? (
            <p className="text-sm text-gray-700 bg-gray-50 border rounded-lg px-3 py-2">
              {tenantId && tenantNameById.get(tenantId)
                ? tenantNameById.get(tenantId)
                : callerTenantId}
              <span className="text-gray-400 text-xs"> {t("tenantFixed")}</span>
            </p>
          ) : (
            <select
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">{t("noTenant")}</option>
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>{t.nombre} ({t.slug})</option>
              ))}
            </select>
          )}
        </div>
        <div>
          {canManageRoles && (
            <>
              <label className="block text-sm font-medium text-gray-700 mb-2">{t("fieldRoles")}</label>
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
                  <p className="text-xs text-gray-400">{t("noRolesForTenant")}</p>
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
          {loading ? t("creating") : t("createUser")}
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
  const t = useTranslations("roles");

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
      setError(t("errUpdateRole"));
    } finally { setLoading(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={t("editRole")}>
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t("fieldName")}</label>
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
          {loading ? t("saving") : t("saveChanges")}
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
  const t = useTranslations("roles");
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
      setError(t("errNameEmail"));
      return;
    }
    setLoading(true); setError("");
    try {
      if (canManageRoles && selectedRoles.size === 0) {
        setError(t("errRoleRequired"));
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
      setError(t("errUpdateUser"));
    } finally { setLoading(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={t("editUserTitle")}>
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t("fieldName")}</label>
          <input
            value={form.nombre}
            onChange={(e) => setForm((p) => ({ ...p, nombre: e.target.value }))}
            className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t("fieldEmail")}</label>
          <input
            type="email"
            value={form.email}
            onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
            className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t("fieldNewPassword")} <span className="text-gray-400 font-normal">{t("passwordHint")}</span>
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
          <label className="block text-sm font-medium text-gray-700 mb-1">{t("fieldTenant")}</label>
          {isTenantAdmin ? (
            <p className="text-sm text-gray-700 bg-gray-50 border rounded-lg px-3 py-2">
              {tenantId && tenantNameById.get(tenantId)
                ? tenantNameById.get(tenantId)
                : callerTenantId}
              <span className="text-gray-400 text-xs"> {t("tenantFixed")}</span>
            </p>
          ) : (
            <>
              <select
                value={tenantId}
                onChange={(e) => setTenantId(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">{t("noTenant")}</option>
                {tenants.map((t) => (
                  <option key={t.id} value={t.id}>{t.nombre} ({t.slug})</option>
                ))}
              </select>
              {!user.superAdmin && (
                <p className="text-xs text-gray-400 mt-1">{t("nonSuperAdminNote")}</p>
              )}
            </>
          )}
        </div>
        <div>
          {canManageRoles ? (
            <>
              <label className="block text-sm font-medium text-gray-700 mb-2">{t("fieldRoles")}</label>
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
                  <p className="text-xs text-gray-400">{t("noRolesForTenant")}</p>
                )}
              </div>
            </>
          ) : (
            <div>
              <p className="text-xs text-gray-500 font-medium mb-1">{t("assignedRoles")}</p>
              <div className="space-y-1">
                {user.roles.length === 0 ? (
                  <p className="text-xs text-gray-400">{t("noRolesAssigned")}</p>
                ) : user.roles.map(({ role }) => (
                  <span key={role.id} className="inline-block text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded mr-1">{role.nombre}</span>
                ))}
              </div>
              <p className="text-xs text-gray-400 mt-1">{t("noRolesPermission")}</p>
            </div>
          )}
        </div>
        {error && <p className="text-sm text-red-500">{error}</p>}
        <button
          onClick={handleSubmit}
          disabled={loading}
          className="w-full bg-blue-600 text-white py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50 transition"
        >
          {loading ? t("saving") : t("saveChanges")}
        </button>
      </div>
    </Modal>
  );
}
