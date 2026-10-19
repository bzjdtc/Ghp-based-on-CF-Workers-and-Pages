import { copyFile, constants } from "node:fs/promises";

const template = new URL("../wrangler.jsonc", import.meta.url);
const local = new URL("../wrangler.local.jsonc", import.meta.url);

try {
  await copyFile(template, local, constants.COPYFILE_EXCL);
  console.log("Created wrangler.local.jsonc. Set your Worker name, domain and rate limit namespaces there before deploying.");
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log("Using existing wrangler.local.jsonc.");
}
