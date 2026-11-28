// End-to-end check of the landmark page in headless Chromium: open a protocol and
// its image, place a 3D point, a barrel and a three-click probe, export the TSV.
//   node scripts/landmarks-smoke.mjs http://localhost:4173/landmarks.html protocol.json image.ims outdir
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";
const [url, protocol, image, outdir] = process.argv.slice(2);
mkdirSync(outdir, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1150 }, deviceScaleFactor: 1, acceptDownloads: true });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
page.on("console", (m) => m.type() === "error" && console.log("console:", m.text()));
await page.goto(url);
await page.setInputFiles("#protocol-input", protocol);
await page.setInputFiles("#file-input", image);
await page.fill("#rater", "smoke");
console.log("protocol:", await page.textContent("#protocol-name"));
await page.click("#start");
await page.waitForSelector("#app:not([hidden])", { timeout: 120000 });
console.log("session:", await page.textContent("#session-info"));

const waitRead = async (label) => {
  const t0 = Date.now();
  await page.waitForFunction(() => / read in /.test(document.getElementById("lm-status").textContent ?? ""), null, { timeout: 300000 });
  await page.waitForTimeout(300);
  console.log(`${label}: ${await page.textContent("#lm-status")} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
};
const shot = (name) => page.screenshot({ path: `${outdir}/${name}.png`, fullPage: true });
const open = async (id) => {
  await page.evaluate(() => (document.getElementById("lm-status").textContent = ""));
  await page.click(`#list li:has(.gid:text-is("${id}"))`);
  await waitRead(id);
};
const clickCanvas = async (i, fx, fy) => {
  const c = (await page.$$(".lm-view canvas"))[i];
  const b = await c.boundingBox();
  await page.mouse.click(b.x + b.width * fx, b.y + b.height * fy);
};

// 1. first landmark: ortho 3D point
await waitRead(await page.textContent("#lm-title"));
await shot("01_point3d");
await clickCanvas(0, 0.52, 0.48);
await page.keyboard.press("Space");
console.log("after place:", await page.textContent("#lm-state"), "|", await page.textContent("#progress"));
// wheel through slices on the sagittal view, then field 0.4 mm (full resolution)
const sag = (await page.$$(".lm-view canvas"))[1];
const sb = await sag.boundingBox();
await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
await page.mouse.wheel(0, -300);
await page.selectOption("#fov", "400");
await page.evaluate(() => (document.getElementById("lm-status").textContent = ""));
await page.dispatchEvent("#fov", "change");
await waitRead("fov 0.4 mm");
await shot("02_point3d_fullres");

// 2. barrel: flat view with depth slider
await page.selectOption("#group-filter", "barrel");
const firstBarrel = await page.textContent("#list li .gid");
await open(firstBarrel);
await shot("03_barrel");
for (const d of ["-80", "-40", "0", "40", "80"]) {
  await page.fill("#depth", d);
  await page.dispatchEvent("#depth", "input");
  await page.waitForTimeout(400);
  await page.waitForFunction(() => !/reading/.test(document.getElementById("lm-status").textContent ?? ""), null, { timeout: 300000 });
  await page.waitForTimeout(800);
  const c = await page.$(".lm-view canvas");
  await c.screenshot({ path: `${outdir}/04_barrel_depth${d}.png` });
}
console.log("barrel:", await page.textContent("#lm-status"));
await clickCanvas(0, 0.45, 0.5);
await page.keyboard.press("Space");

// 3. hippocampus locked plane
await page.selectOption("#group-filter", "hippo");
await open(await page.textContent("#list li .gid"));
await shot("05_hippo");

// 4. layer probe: three clicks
await page.selectOption("#group-filter", "probe");
await open(await page.textContent("#list li .gid"));
// pia, then white matter, then the suggested layer 4
await clickCanvas(0, 0.5, 0.2);
await page.keyboard.press("Space");
await page.click('#lm-clicks button:has-text("3. WM")');
await clickCanvas(0, 0.5, 0.8);
await page.keyboard.press("Space");
await page.click("#suggest-l4");
console.log("suggest:", await page.textContent("#lm-status"));
await page.keyboard.press("Space");
console.log("probe:", await page.textContent("#lm-clicks"), "|", await page.textContent("#lm-state"));
await shot("06_probe");

// export
await page.selectOption("#group-filter", "");
const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#export-tsv")]);
const path = `${outdir}/${dl.suggestedFilename()}`;
await dl.saveAs(path);
console.log("exported", path);
console.log(await (await import("node:fs")).promises.readFile(path, "utf8"));
await browser.close();
