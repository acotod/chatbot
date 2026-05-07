import type { Permission } from "@/lib/permissions";
import {
  canAccessNavItem,
  filterAuthorizedNavItems,
  resolveAuthorizedFallback,
  resolveBlockedPathRedirect,
  type SidebarAccessContext,
  type SidebarNavItem,
} from "@/lib/sidebarAccess";

const NAV_ITEMS: SidebarNavItem[] = [
  { href: "/dashboard", permission: "VIEW_DASHBOARD" },
  { href: "/solicitudes", permission: "VIEW_SOLICITUDES" },
  { href: "/facturacion", superAdminOnly: true },
];

function ctx(superAdmin: boolean, permissions: Permission[]): SidebarAccessContext {
  return {
    superAdmin,
    permissionSet: new Set(permissions),
  };
}

describe("sidebar access helpers", () => {
  it("allows superadmin to access every nav item", () => {
    const context = ctx(true, []);
    expect(filterAuthorizedNavItems(NAV_ITEMS, context)).toHaveLength(3);
  });

  it("blocks superAdminOnly item for non-superadmin", () => {
    const context = ctx(false, ["VIEW_DASHBOARD"]);
    expect(canAccessNavItem(NAV_ITEMS[2], context)).toBe(false);
  });

  it("resolves fallback to first allowed item", () => {
    const context = ctx(false, ["VIEW_SOLICITUDES"]);
    expect(resolveAuthorizedFallback(NAV_ITEMS, context, "/login")).toBe(
      "/solicitudes"
    );
  });

  it("resolves fallback to /login when there are no authorized items", () => {
    const context = ctx(false, []);
    expect(resolveAuthorizedFallback(NAV_ITEMS, context, "/login")).toBe(
      "/login"
    );
  });

  it("blocks direct URL access for unauthorized route", () => {
    const context = ctx(false, ["VIEW_DASHBOARD"]);
    const redirect = resolveBlockedPathRedirect(
      NAV_ITEMS,
      "/solicitudes/123",
      context,
      "/login"
    );

    expect(redirect).toEqual({
      blocked: true,
      fallback: "/dashboard",
    });
  });

  it("does not block unknown route entries in sidebar map", () => {
    const context = ctx(false, []);
    const redirect = resolveBlockedPathRedirect(
      NAV_ITEMS,
      "/ruta-no-sidebar",
      context,
      "/login"
    );

    expect(redirect).toEqual({ blocked: false, fallback: null });
  });
});
