import type { Permission } from "@/lib/permissions";

export type SidebarNavItem = {
  href: string;
  permission?: Permission;
  superAdminOnly?: boolean;
};

export type SidebarAccessContext = {
  superAdmin: boolean;
  permissionSet: Set<Permission>;
};

export function canAccessNavItem<T extends SidebarNavItem>(
  item: T,
  context: SidebarAccessContext
): boolean {
  if (context.superAdmin) return true;
  if (item.superAdminOnly) return false;
  if (!item.permission) return false;
  return context.permissionSet.has(item.permission);
}

export function filterAuthorizedNavItems<T extends SidebarNavItem>(
  navItems: T[],
  context: SidebarAccessContext
): T[] {
  return navItems.filter((item) => canAccessNavItem(item, context));
}

export function resolveAuthorizedFallback<T extends SidebarNavItem>(
  navItems: T[],
  context: SidebarAccessContext,
  defaultHref = "/login"
): string {
  return filterAuthorizedNavItems(navItems, context)[0]?.href ?? defaultHref;
}

export function findMatchingNavItem<T extends SidebarNavItem>(
  navItems: T[],
  pathname: string
): T | undefined {
  return navItems.find(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`)
  );
}

export function resolveBlockedPathRedirect<T extends SidebarNavItem>(
  navItems: T[],
  pathname: string,
  context: SidebarAccessContext,
  defaultHref = "/login"
): { blocked: boolean; fallback: string | null } {
  const currentItem = findMatchingNavItem(navItems, pathname);
  if (!currentItem) return { blocked: false, fallback: null };
  if (canAccessNavItem(currentItem, context)) {
    return { blocked: false, fallback: null };
  }
  return {
    blocked: true,
    fallback: resolveAuthorizedFallback(navItems, context, defaultHref),
  };
}