// End-to-end check in headless Chromium: open an image through the worker, check the
// busy popup, that rotating moves nothing but the brain, and take screenshots.
//   node scripts/browser-smoke.mjs http://localhost:4173 <file.ims|file.ozx|folder.ome.zarr> out.png
import { statSync } from "node:fs";
import { chromium } from "playwright-core";
const [url, path, out] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(url);
const t0 = Date.now();
const isFolder = statSync(path).isDirectory();
await page.setInputFiles(isFolder ? "#folder-input" : "#file-input", path);
await page.waitForSelector("#busy:not([hidden])", { timeout: 60000 });
await page.waitForFunction(() => (document.getElementById("busy-bar").value ?? 0) > 0.3, null, { timeout: 300000 });
console.log("busy:", await page.textContent("#busy-message"), await page.$eval("#busy-bar", (b) => b.value.toFixed(2)));
await page.screenshot({ path: out.replace(".png", "_busy.png") });
await page.waitForSelector("#busy", { state: "hidden", timeout: 600000 });
console.log(`loaded in ${(Date.now() - t0) / 1000}s; status: "${await page.textContent("#status")}"`);
if (await page.isHidden("#app")) process.exit(1);
console.log("orientation:", await page.inputValue("#orientation"), "preset:", await page.inputValue("#preset"));
const boxes = () => page.$$eval(".view canvas, .view span", (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [e.textContent, r.x, r.y, r.width, r.height].join(","); }).join("|"));
const before = await boxes();
await page.screenshot({ path: out });
const t1 = Date.now();
await page.click('[data-rot="S,1"]');
console.log("after turn about S:", await page.inputValue("#orientation"), `${Date.now() - t1} ms`, "layout unchanged:", before === (await boxes()));
await page.screenshot({ path: out.replace(".png", "_rot.png") });
await page.click('input[name="mode"][value="slice"]');
console.log("slice mode layout unchanged:", before === (await boxes()));
await browser.close();
