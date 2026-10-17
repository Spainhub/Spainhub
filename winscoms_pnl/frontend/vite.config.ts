import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Приложение открывается по адресу https://winscoms.com/pnl/
export default defineConfig({
  base: "/pnl/",
  plugins: [react()],
  server: {
    proxy: {
      "/pnl/api": { target: "http://localhost:8000", rewrite: (p) => p.replace(/^\/pnl/, "") },
    },
  },
});
