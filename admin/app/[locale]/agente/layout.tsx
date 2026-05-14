// Force dynamic rendering for all agent pages (auth-gated, uses client-side stores)
export const dynamic = "force-dynamic";

export default function AgenteLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
