/** Minimal public landing page: explains the product and routes visitors to sign-in. */
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { AuthShell } from '@/components/AuthShell';
import { MANAGED_ACCOUNT_NOTE } from '@/gen/auth/gateway';
import { useAuth } from '@/gen/auth/AuthProvider';

const POINTS = [
  'Describe a webpage application and get runnable HTML, CSS and JavaScript.',
  'Preview every generated version in a sandboxed viewer and keep a full prompt history.',
  'Projects are saved to your account, so you only ever see your own work.',
];

export default function Landing() {
  const { status } = useAuth();
  const signedIn = status === 'authenticated';

  return (
    <AuthShell
      title="Spec2App Verify"
      subtitle="Turn a plain-language idea into a working single-page web application, verified inside a sandboxed viewer."
    >
      <ul className="space-y-3 text-sm text-slate-700">
        {POINTS.map((point) => (
          <li key={point} className="flex gap-2">
            <span aria-hidden className="mt-1 h-2 w-2 shrink-0 rounded-full bg-indigo-600" />
            <span>{point}</span>
          </li>
        ))}
      </ul>
      <div className="mt-6 flex flex-col gap-2">
        <Button asChild className="w-full">
          <Link to={signedIn ? '/app' : '/sign-in'}>{signedIn ? 'Open the generator' : 'Sign in'}</Link>
        </Button>
        {signedIn ? (
          <Link className="text-center text-xs text-slate-600 underline" to="/sign-in">
            Switch account
          </Link>
        ) : (
          <p className="text-center text-xs text-slate-500">{MANAGED_ACCOUNT_NOTE}</p>
        )}
      </div>
    </AuthShell>
  );
}
