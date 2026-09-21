import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    typescript: {
      // The CLI (bin/netlas.ts) lives outside src/, so add it to the generated
      // tsconfig's include — otherwise editors type-check it as a loose file and
      // flag its ".ts" import extensions (allowImportingTsExtensions is off in
      // the inferred project).
      config(tsconfig) {
        tsconfig.include.push('../bin/**/*.ts');
        return tsconfig;
      },
    },
  },
};

export default config;
