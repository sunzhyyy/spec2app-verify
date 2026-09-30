/** Route guard: the generator is only reachable with a restored session. */
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { accessDecision } from '@/gen/auth/access';
import { useAuth } from '@/gen/auth/AuthProvider';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();

  const decision = accessDecision(status);
  if (decision === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-700">
        <p role="status">Restoring your session…</p>
      </div>
    );
  }
  if (decision === 'sign-in') return <Navigate to="/sign-in" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}
