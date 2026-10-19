import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Продакшен: https://finans.winscoms.com/ (корень поддомена).
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://localhost:8000" } },
});
