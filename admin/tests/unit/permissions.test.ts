import {
  buildPermissionSet,
  normalizePermissions,
  type Permission,
} from "@/lib/permissions";

describe("permissions helpers", () => {
  it("normalizes casing and trims whitespace", () => {
    const normalized = normalizePermissions([
      " view_dashboard ",
      "VIEW_SOLICITUDES",
      "  edit_flujos",
    ]);

    expect(normalized).toEqual([
      "VIEW_DASHBOARD",
      "VIEW_SOLICITUDES",
      "EDIT_FLUJOS",
    ]);
  });

  it("ignores nullish and non-array inputs", () => {
    expect(normalizePermissions(null)).toEqual([]);
    expect(normalizePermissions(undefined)).toEqual([]);
    expect(normalizePermissions("VIEW_DASHBOARD")).toEqual([]);
  });

  it("builds deduplicated permission set", () => {
    const permissionSet = buildPermissionSet([
      " view_dashboard ",
      "VIEW_DASHBOARD",
      "view_dashboard",
    ]);

    expect(permissionSet.size).toBe(1);
    expect(permissionSet.has("VIEW_DASHBOARD" as Permission)).toBe(true);
  });
});
