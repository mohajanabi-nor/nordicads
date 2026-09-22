/**
 * The login screen — the only page reachable without a session.
 *
 * No sign-up link, no password reset: there is one account, created by hand in
 * the Supabase dashboard. Offering self-service flows here would mean wiring up
 * transactional email for a single operator who can already reach the dashboard.
 */
export const metadata = { title: "Logg inn — Nordic Engros" };

export default function LoginPage({
  searchParams,
}: {
  searchParams: { feil?: string; neste?: string };
}) {
  const error = searchParams.feil;

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-sm flex-col justify-center">
      <div className="rounded-2xl border border-line bg-cream-2/60 p-7 shadow-sm">
        <div className="mb-6">
          <h1 className="text-xl font-extrabold tracking-tight text-ink">Logg inn</h1>
          <p className="mt-1 text-sm text-ink/60">
            Kontrollpanelet er ikke åpent — du må være innlogget for å se noe.
          </p>
        </div>

        {error ? (
          <p
            role="alert"
            className="mb-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
          >
            {error}
          </p>
        ) : null}

        <form action="/api/auth/login" method="post" className="space-y-4">
          <input type="hidden" name="neste" value={searchParams.neste ?? ""} />

          <label className="block">
            <span className="mb-1 block text-sm font-semibold text-ink/80">E-post</span>
            <input
              type="email"
              name="email"
              autoComplete="username"
              required
              autoFocus
              className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-orange"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-semibold text-ink/80">Passord</span>
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              required
              className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-orange"
            />
          </label>

          <button
            type="submit"
            className="w-full rounded-lg bg-orange px-4 py-2.5 text-sm font-bold text-cream hover:opacity-90"
          >
            Logg inn
          </button>
        </form>
      </div>
    </div>
  );
}
