import { motion } from "framer-motion";

interface DockItemProps {
  icon: string;
  label: string;
  active?: boolean;
  onClick: () => void;
}

export function DockItem({ icon, label, active, onClick }: DockItemProps) {
  return (
    <motion.div
      style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, cursor: "pointer" }}
      whileHover={{ scale: 1.15, y: -4 }}
      whileTap={{ scale: 0.95 }}
      transition={{ type: "spring", stiffness: 500, damping: 28 }}
      onClick={onClick}
      title={label}
    >
      <img
        src={icon}
        alt={label}
        style={{ width: 36, height: 36, objectFit: "contain" }}
      />
      {active && (
        <div style={{ width: 3, height: 3, borderRadius: "50%", background: "rgba(255,255,255,0.65)" }} />
      )}
    </motion.div>
  );
}
