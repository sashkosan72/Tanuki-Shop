import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");

// Compile only: do not run browser scripts or contact third-party services.
for (const path of ["public/index.html", "public/admin/index.html"]) {
  const html = await read(path);
  const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
  const ids = [...markup.matchAll(/(?:^|\s)id\s*=\s*"([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size, `${path}: duplicate HTML id`);
  const knownIds = new Set(ids);
  let scripts = 0;

  for (const [, attributes, source] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/i.test(attributes)) continue;
    new vm.Script(source, { filename: `${path}:inline-${++scripts}` });
    for (const [, id] of source.matchAll(/\$\(\s*"([^"]+)"\s*\)/g)) {
      assert(knownIds.has(id), `${path}: missing HTML id ${id}`);
    }
  }
  console.log(`${path}: ${scripts} inline scripts compile; literal DOM ids resolve`);
}

new vm.Script(await read("public/app.js"), { filename: "public/app.js" });
const syntax = spawnSync(process.execPath, ["--input-type=module", "--check"], {
  input: await read("src/index.js"),
  encoding: "utf8",
  cwd: root
});
assert.equal(syntax.status, 0, syntax.stderr || "Worker syntax check failed");

const production = JSON.parse(await read("wrangler.jsonc"));
const local = JSON.parse(await read("wrangler.local.jsonc"));
for (const config of [production, local]) {
  assert((await stat(new URL(`../${config.main}`, import.meta.url))).isFile());
  assert((await stat(new URL(`../${config.assets.directory}`, import.meta.url))).isDirectory());
  assert.equal(config.assets.binding, "ASSETS");
  assert(config.d1_databases.some(binding => binding.binding === "DB"));
  assert(config.r2_buckets.some(binding => binding.binding === "PRODUCT_IMAGES"));
}
assert.notEqual(local.name, production.name);
for (const key of ["d1_databases", "r2_buckets"]) {
  for (const binding of local[key]) assert.equal(binding.remote, false);
}
assert.notEqual(local.d1_databases[0].database_id, production.d1_databases[0].database_id);
assert.notEqual(local.d1_databases[0].database_name, production.d1_databases[0].database_name);
assert.notEqual(local.r2_buckets[0].bucket_name, production.r2_buckets[0].bucket_name);
assert(!local.routes && !local.route, "Local config must not configure production routes");
console.log("Worker/app syntax and config paths valid; local bindings are isolated");
