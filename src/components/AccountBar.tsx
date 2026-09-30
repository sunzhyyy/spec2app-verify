/** Signed-in identity plus sign-out, shown in the generator sidebar. */
import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function AccountBar({ email, syncing, onSignOut }: { email: string; syncing: boolean; onSignOut: () => void }) {
  return (
    <div className="border-b border-slate-200 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Account</p>
      <p className="mt-1 truncate text-sm text-slate-800" title={email}>
        {email || 'Signed in'}
      </p>
      <p className="mt-0.5 text-xs text-slate-500" data-testid="sync-status">
        {syncing ? 'Syncing projects…' : 'Projects saved to your account'}
      </p>
      <Button size="sm" variant="outline" className="mt-2 w-full !bg-transparent" onClick={onSignOut}>
        <LogOut className="mr-2 h-4 w-4" aria-hidden />
        Sign out
      </Button>
    </div>
  );
}
