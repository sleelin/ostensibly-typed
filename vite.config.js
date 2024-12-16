import {defineConfig} from "vite";

export default defineConfig({
    base: "./",
    build: {
        minify: false,
        lib: {
            formats: ["es"],
            entry: {
                "index": "src/index.js",
                "plugins/rollup": "src/plugin/rollup.js"
            },
        },
        rollupOptions: {
            external: ["typescript", "path"]
        }
    }
});