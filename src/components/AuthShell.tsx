/** Centered card shared by the public pages so sign-in, the landing page and the callback look identical. */
import type { ReactNode } from 'react';

export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-slate-50 px-4 py-10 text-slate-900">
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center">
        <header className="mb-6 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-2 text-sm text-slate-600">{subtitle}</p>
        </header>
        <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">{children}</div>
        {footer && <div className="mt-4 text-center text-sm text-slate-600">{footer}</div>}
      </main>
      <footer className="mx-auto mt-8 max-w-md text-center text-xs text-slate-500">
        Spec2App Verify · projects are stored in your account
      </footer>
    </div>
  );
}
