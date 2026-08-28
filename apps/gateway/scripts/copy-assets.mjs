import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(join(root, "dist"), { recursive: true });
await Promise.all([
  copyFile(join(root, "scripts", "install.ps1"), join(root, "dist", "install.ps1")),
  copyFile(join(root, "README.md"), join(root, "dist", "README.md")),
]);
