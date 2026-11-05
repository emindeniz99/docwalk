import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    // Mermaid 12 targets ES2024 / Safari 17.4, which sets the floor (decision 31).
    target: ["es2024", "safari17.4"],
  },
});
