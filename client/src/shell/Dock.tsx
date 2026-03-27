import { DockItem } from "./DockItem";
import { usePanelState, PanelId } from "../hooks/usePanelState";

const ITEMS: { id: PanelId; icon: string; label: string }[] = [
  { id: "camera",   icon: "/ui/camera.svg",    label: "Camera"   },
  { id: "settings", icon: "/ui/settings.svg",  label: "Settings" },
  { id: "terminal", icon: "/ui/terminal.svg",  label: "Terminal" },
  { id: "docs",     icon: "/ui/docs.svg",      label: "Docs"     },
  { id: "about",    icon: "/ui/about.svg",     label: "About"    },
];

export function Dock() {
  const { panels, toggle } = usePanelState();

  return (
    <div
      style={{
        position: "fixed",
        bottom: 8,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 10,
        display: "flex",
        alignItems: "flex-end",
        gap: 12,
        padding: "10px 16px",
        background: "rgba(255,255,255,0.08)",
        backdropFilter: "blur(24px) saturate(180%)",
        WebkitBackdropFilter: "blur(24px) saturate(180%)",
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 16,
      }}
    >
      {ITEMS.map((item) => (
        <DockItem
          key={item.id}
          icon={item.icon}
          label={item.label}
          active={panels[item.id] === "open"}
          onClick={() => toggle(item.id)}
        />
      ))}
    </div>
  );
}
