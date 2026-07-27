export default function Home() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="max-w-lg text-center px-8">
        <p className="font-mono text-xs tracking-[0.16em] text-teal-deep uppercase">
          Hized Platform
        </p>
        <h1 className="mt-4 font-display text-3xl font-bold tracking-tight text-ink">
          Secure shell — Phase 0
        </h1>
        <p className="mt-4 text-base leading-relaxed text-muted">
          Tenancy, authentication and the organisation hierarchy live here.
          Nothing customer-facing yet — this placeholder confirms the design
          system, environment and CI pipeline are wired up end to end.
        </p>
      </div>
    </div>
  );
}
