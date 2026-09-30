/**
 * Sign-in entry point.
 *
 * Signing in is handled by the platform identity provider: the button starts an OIDC redirect and
 * the provider returns through the callback route, so this page never collects, validates, hashes
 * or stores a password. If a provider redirect lands on this route instead, it is completed here.
 */
import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { AuthShell } from '@/components/AuthShell';
import { isAuthCallback } from '@/gen/auth/callback';
import { GENERIC_AUTH_ERROR, MANAGED_ACCOUNT_NOTE } from '@/gen/auth/gateway';
import { useAuth } from '@/gen/auth/AuthProvider';

export default function SignIn() {
  const { status, startSignIn, completeCallback } = useAuth();
  const navigate = useNavigate();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [completing, setCompleting] = useState(() => isAuthCallback(window.location.search));

  useEffect(() => {
    if (!completing) return;
    let active = true;
    void completeCallback().then((outcome) => {
      if (!active) return;
      if (outcome.status === 'authenticated') {
        navigate('/app', { replace: true });
        return;
      }
      setCompleting(false);
      setMessage(outcome.status === 'anonymous' ? outcome.message ?? GENERIC_AUTH_ERROR : GENERIC_AUTH_ERROR);
    });
    return () => {
      active = false;
    };
  }, [completing, completeCallback, navigate]);

  if (status === 'authenticated' && !completing) return <Navigate to="/app" replace />;

  const signIn = () => {
    if (busy || completing) return;
    setMessage(null);
    setBusy(true);
    const outcome = startSignIn();
    // A redirect is in flight: keep the button disabled until the browser leaves this page.
    if (outcome.status === 'redirecting') return;
    setBusy(false);
    setMessage(outcome.status === 'anonymous' ? outcome.message ?? GENERIC_AUTH_ERROR : GENERIC_AUTH_ERROR);
  };

  return (
    <AuthShell
      title="Sign in"
      subtitle="Sign in with your platform account to create webpages and keep every project in your own account."
      footer={
        <Link className="underline" to="/">
          Back to overview
        </Link>
      }
    >
      {completing ? (
        <p role="status" className="text-sm text-slate-700">
          Completing sign-in…
        </p>
      ) : (
        <>
          {message && (
            <p role="alert" className="mb-4 rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-900">
              {message}
            </p>
          )}
          <Button className="w-full" onClick={signIn} disabled={busy || status === 'checking'}>
            {status === 'checking' ? 'Checking your session…' : busy ? 'Redirecting…' : 'Continue to sign in'}
          </Button>
          <p className="mt-3 text-xs text-slate-500">{MANAGED_ACCOUNT_NOTE}</p>
        </>
      )}
    </AuthShell>
  );
}
