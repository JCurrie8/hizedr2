"use client";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="max-w-md px-8 text-center">
        <h1 className="font-display text-2xl font-bold text-ink">Something went wrong</h1>
        <p className="mt-3 text-sm text-muted">{error.message || "An unexpected error occurred."}</p>
        <button
          type="button"
          onClick={reset}
          className="mt-6 rounded-md bg-navy px-4 py-2 text-sm font-semibold text-white"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
