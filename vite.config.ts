import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import process from "node:process";
import path from "node:path";

const root = process.cwd();
const resolve = (...paths: string[]) => path.resolve(root, ...paths);

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /@\/state\//,
        replacement: `${resolve("src/source/state")}/`,
      },
      {
        find: /@\/view\//,
        replacement: `${resolve("src/source/view")}/`,
      },
    ],
  },
  server: {
    port: 5100,
  },
});
