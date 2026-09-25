import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const configDir = path.dirname(fileURLToPath(import.meta.url));

function sha256File(filePath: string): string | null {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
  } catch {
    return null;
  }
}

function buildFingerprintPlugin() {
  return {
    name: "aster-build-fingerprint",
    generateBundle(_options: unknown, bundle: Record<string, { type: string; code?: string; source?: string | Uint8Array }>) {
      const digest = crypto.createHash("sha256");
      for (const name of Object.keys(bundle).sort()) {
        const item = bundle[name];
        digest.update(name);
        digest.update(item.type === "chunk" ? item.code ?? "" : item.source ?? "");
      }
      this.emitFile({
        type: "asset",
        fileName: "build-meta.json",
        source: `${JSON.stringify({
          schema: 1,
          frontendBundleSha256: digest.digest("hex").toUpperCase(),
          backendSourceSha256: sha256File(path.resolve(configDir, "..", "server.mjs")),
          databaseSourceSha256: sha256File(path.resolve(configDir, "..", "inventory-db.mjs")),
          lingxingHostSourceSha256: sha256File(path.resolve(configDir, "..", "lingxing-host.mjs")),
        }, null, 2)}\n`,
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), buildFingerprintPlugin()],
  server: {
    /* 验证脚本固定访问 127.0.0.1，避免仅绑定 IPv6(::1) 导致 connection refused */
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4173",
    },
  },
});
