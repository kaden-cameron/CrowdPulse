import { useParams } from "react-router-dom";
import { Dock } from "../components/Dock";
import { MenuBar } from "../components/MenuBar";
import { useHostAccess } from "../components/HostAccess";
import { PlayerCard } from "../components/PlayerCard";
import { useSessionSocket } from "../hooks/useSessionSocket";
import { useSessionAppearance } from "../lib/theme";
import { HostSignIn } from "./HostPage";

// Speaker-only view of the host page's Now playing window, for a separate laptop on the sound
// system. The host page itself can also be the player (Start audio on this device).

export function PlayerPage() {
  const { sessionCode = "demo" } = useParams();
  const access = useHostAccess();
  const { state, status, lastMessageAt, applyState } = useSessionSocket(sessionCode, "stage");
  useSessionAppearance(sessionCode, state?.appearance);

  return (
    <main className="host-page">
      <MenuBar title="Player" status={status} lastMessageAt={lastMessageAt} />
      <section className="host-grid player-grid">
        <div className="host-block">
          <h1>Player · {state?.sessionName ?? sessionCode}</h1>
          <p className="host-sub">
            Open this on the laptop connected to the speakers, or just use the host page — its Now
            playing window can be the player too.
          </p>
          <HostSignIn />
        </div>
        <PlayerCard
          sessionCode={sessionCode}
          state={state}
          ready={access.ready}
          getHeaders={access.getHeaders}
          onState={applyState}
        />
      </section>
      <Dock sessionCode={sessionCode} />
    </main>
  );
}
