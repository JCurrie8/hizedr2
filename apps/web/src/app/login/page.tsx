import { LoginForm } from "@/components/LoginForm";

export default function LoginPage() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="w-full max-w-sm px-8">
        <p className="font-mono text-xs uppercase tracking-[0.16em] text-teal-deep">Hized Platform</p>
        <h1 className="mt-2 font-display text-2xl font-bold text-ink">Sign in</h1>
        <div className="mt-6">
          <LoginForm />
        </div>
      </div>
    </div>
  );
}
