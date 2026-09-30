/** Detects the platform identity-provider redirect so the callback is completed exactly once. */
const CALLBACK_PARAMS = ['token', 'code', 'platform_token', 'id_token'];

export function isAuthCallback(search: string): boolean {
  if (!search) return false;
  const params = new URLSearchParams(search);
  return CALLBACK_PARAMS.some((name) => {
    const value = params.get(name);
    return Boolean(value && value.trim());
  });
}
