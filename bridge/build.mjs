import { build } from "esbuild";
import { upstreamBuild } from "./src/t3/upstreamBuild.ts";

const common = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  target: "node26",
  plugins: [
    {
      name: "t3-build-metadata",
      setup(build) {
        build.onLoad({ filter: /[\\/]t3[\\/]upstreamBuild\.ts$/ }, () => ({
          contents: `export const upstreamBuild = ${JSON.stringify(upstreamBuild)};`,
          loader: "js",
        }));
      },
    },
  ],
  legalComments: "linked",
  banner: {
    js: "// Omarchy T3 Command Center bridge; T3 Code portions are MIT licensed. See THIRD_PARTY_NOTICES.md.",
  },
};

await Promise.all([
  build({
    ...common,
    outfile: "dist/t3-mini-bridge.mjs",
    format: "esm",
    sourcemap: true,
  }),
  build({
    ...common,
    outfile: "dist/t3-mini-bridge.cjs",
    format: "cjs",
    sourcemap: false,
  }),
]);
