import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { finishSpotifyLogin } from "../lib/spotify/auth";

/** Spotify sends the host back here after login; swap the code for tokens and return to the player. */
export function SpotifyCallbackPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    finishSpotifyLogin(params)
      .then((returnTo) => navigate(returnTo || "/", { replace: true }))
      .catch((err: Error) => setError(err.message));
    // Run once: the code can only be exchanged one time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="host-page">
      <section className="host-grid">
        <div className="host-block">
          <h1>{error ? "Spotify login failed" : "Connecting Spotify…"}</h1>
          {error && (
            <>
              <p className="feedback feedback-rejected">{error}</p>
              <a className="btn ghost" href="/player/demo">
                Back to the player
              </a>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
