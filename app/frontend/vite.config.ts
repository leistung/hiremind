import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const backendProxy = { "/api": { target: process.env.VITE_BACKEND_PROXY || "http://127.0.0.1:8001", changeOrigin: false } };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  server: { port: 5173, proxy: backendProxy },
  preview: { port: 3001, proxy: backendProxy },
});
