import { defineConfig } from "vite";

// The check logic is shared with the hosted Cheap First in ../src.
export default defineConfig({
  server: { fs: { allow: [".."] } },
  build: { outDir: "dist", target: "es2022" },
});
