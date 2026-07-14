import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 8080,
    proxy: {
      "/v1": process.env.VITE_API_URL ?? "http://localhost:8081",
      "/healthz": process.env.VITE_API_URL ?? "http://localhost:8081",
    },
  },
});
