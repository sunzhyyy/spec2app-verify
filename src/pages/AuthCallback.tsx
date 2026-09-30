/** Dedicated route for the identity-provider redirect, in case it is configured to return to /auth/callback. */
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthShell } from '@/components/AuthShell';
import { GENERIC_AUTH_ERROR } from '@/gen/auth/gateway';
import { useAuth } from '@/gen/auth/AuthProvider';

export default function AuthCallback() {
  const { completeCallback } = useAuth();
  const navigate = useNavigate();
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void completeCallback().then((outcome) => {
      if (!active) return;
      if (outcome.status === 'authenticated') {
        navigate('/app', { replace: true });
        return;
      }
      setMessage(outcome.status === 'anonymous' ? outcome.message ?? GENERIC_AUTH_ERROR : GENERIC_AUTH_ERROR);
    });
    return () => {
      active = false;
    };
  }, [completeCallback, navigate]);

  return (
    <AuthShell
      title="Completing sign-in"
      subtitle="Finishing the sign-in started with your identity provider."
      footer={
        <Link className="underline" to="/sign-in">
          Back to sign in
        </Link>
      }
    >
      {message ? (
        <p role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          {message}
        </p>
      ) : (
        <p role="status" className="text-sm text-slate-700">
          Verifying your session…
        </p>
      )}
    </AuthShell>
  );
}
