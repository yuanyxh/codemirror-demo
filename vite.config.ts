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
      {
        find: /@\/language\//,
        replacement: `${resolve("src/source/language")}/`,
      },
      {
        find: /@\/commands\//,
        replacement: `${resolve("src/source/commands")}/`,
      },
      {
        find: /@\/search\//,
        replacement: `${resolve("src/source/search")}/`,
      },
      {
        find: /@\/autocomplete\//,
        replacement: `${resolve("src/source/autocomplete")}/`,
      },
      {
        find: /@\/lint\//,
        replacement: `${resolve("src/source/lint")}/`,
      },
      {
        find: /@\/basic-setup\//,
        replacement: `${resolve("src/source/basic-setup")}/`,
      },
    ],
  },
  server: {
    port: 5100,
  },
});
