import { motion, AnimatePresence } from "framer-motion";
import { usePanelState } from "../hooks/usePanelState";

export function AboutModal() {
  const isOpen = usePanelState((s) => s.panels.about === "open");
  const close = usePanelState((s) => s.close);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => close("about")}
            style={{ position: "fixed", inset: 0, zIndex: 39, background: "rgba(0,0,0,0.4)" }}
          />
          {/* Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.92 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              zIndex: 40,
              width: 360,
              background: "#141414",
              border: "1px solid rgba(255,255,255,0.06)",
              borderRadius: 14,
              boxShadow: "0 24px 64px rgba(0,0,0,0.85)",
              padding: 28,
              fontFamily: "'Urbanist', -apple-system, sans-serif",
              color: "rgba(255,255,255,0.85)",
              textAlign: "center",
            }}
          >
            <img src="/logo.png" alt="OnaPose" style={{ width: 64, height: 64, marginBottom: 12 }} />
            <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>OnaPose</div>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", marginBottom: 16 }}>v0.1.0</div>
            <div style={{
              background: "#1c1c1e",
              borderRadius: 8,
              padding: "12px 14px",
              fontSize: 13,
              color: "rgba(255,255,255,0.55)",
              lineHeight: 1.6,
              marginBottom: 20,
              textAlign: "left",
            }}>
              Browser-based full body motion capture with OSC/VMC output.
              Runs entirely on macOS without Electron or Windows-only dependencies.
            </div>
            <button
              onClick={() => close("about")}
              style={{
                background: "rgba(255,255,255,0.1)",
                border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: 8,
                color: "rgba(255,255,255,0.8)",
                fontSize: 13,
                padding: "6px 20px",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Close
            </button>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
