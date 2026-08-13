"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface NavigationItem {
  label: string;
  href: string;
  section: "home" | "pulse" | "canvas" | "connect" | "settings";
}

export function activeSection(pathname: string): NavigationItem["section"] | null {
  const tenantPath = pathname.replace(/^\/t\/[a-z0-9]+(?:-[a-z0-9]+)*/, "") || "/";
  if (tenantPath === "/home") return "home";
  if (tenantPath === "/dashboard" || tenantPath.startsWith("/dashboard/")) return "pulse";
  if (tenantPath === "/canvas" || tenantPath.startsWith("/canvas/")) return "canvas";
  if (tenantPath === "/admin/connect" || tenantPath.startsWith("/admin/connect/")) return "connect";
  if (tenantPath === "/admin" || tenantPath.startsWith("/admin/")) return "settings";
  return null;
}

export function TenantNavigation({ items }: { items: NavigationItem[] }) {
  const current = activeSection(usePathname());

  return (
    <nav aria-label="Main navigation" className="-mx-1 flex gap-0 overflow-x-auto pb-3 text-xs [scrollbar-width:none] sm:gap-1 sm:text-sm">
      {items.map((item) => {
        const active = current === item.section;
        return (
          <Link
            key={item.section}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`whitespace-nowrap rounded-md px-2.5 py-2 transition-colors sm:px-3 ${
              active
                ? "font-semibold"
                : "text-muted hover:bg-canvas hover:text-ink"
            }`}
            style={active ? {
              backgroundColor: "var(--tenant-primary)",
              color: "var(--tenant-primary-foreground)",
            } : undefined}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
