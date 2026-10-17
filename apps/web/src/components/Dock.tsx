import { NavLink } from "react-router-dom";

// Bottom dock of icon tiles for moving between CrowdPulse pages (host-side pages only).

const ITEMS = [
  { to: "/join", icon: "📱", label: "Join" },
  { to: "/stage", icon: "📺", label: "Stage" },
  { to: "/host", icon: "🎛️", label: "Host" },
  { to: "/player", icon: "🔊", label: "Player" },
];

export function Dock({ sessionCode = "demo" }: { sessionCode?: string }) {
  return (
    <nav className="dock" aria-label="CrowdPulse pages">
      {ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={`${item.to}/${sessionCode}`}
          className={({ isActive }) => `dock-item${isActive ? " active" : ""}`}
        >
          <span className="dock-icon" aria-hidden>
            {item.icon}
          </span>
          <span className="dock-label">{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
