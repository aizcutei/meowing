import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  build: {
    // The whole point of the app is producing large JSON blobs; keep the client lean.
    chunkSizeWarningLimit: 700,
  },
});
