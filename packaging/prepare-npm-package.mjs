import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const manifestPath = join("node_modules", "pptxgenjs", "package.json");
const backupPath = join("node_modules", ".copilot-pptxgenjs-manifest.json");

if (process.argv.includes("--restore")) {
  const original = await readFile(backupPath, "utf8");
  await writeFile(manifestPath, original);
  await rm(backupPath);
} else {
  const project = JSON.parse(await readFile("package.json", "utf8"));
  const patchedVersion = project.overrides?.["image-size"];
  const installed = JSON.parse(await readFile(join("node_modules", "image-size", "package.json"), "utf8"));
  if (typeof patchedVersion !== "string" || installed.version !== patchedVersion) {
    throw new Error("Run npm ci before packing: the approved image-size override is not installed.");
  }
  const original = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(original);
  if (manifest.name !== "pptxgenjs" || typeof manifest.dependencies?.["image-size"] !== "string") {
    throw new Error("The bundled presentation dependency has an unexpected manifest; review the image-size patch.");
  }
  // npm ignores a dependency's overrides; the bundled manifest must declare the tested patch.
  await writeFile(backupPath, original, { flag: "wx" });
  manifest.dependencies["image-size"] = patchedVersion;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
