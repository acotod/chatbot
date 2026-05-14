// Force dynamic rendering — all admin app pages are auth-gated
export const dynamic = "force-dynamic";

import MainLayout from "@/components/layout/MainLayout";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <MainLayout>{children}</MainLayout>;
}
