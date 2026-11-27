// Headless check of the panels below the views: automatic zooms, a click to add one,
// window/level, metrics and the PSF estimate. Full-page screenshot at the end.
//   node scripts/browser-panels.mjs http://localhost:4173 <image> out.png
import { statSync } from "node:fs";
import { chromium } from "playwright-core";
const [url, path, out] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
page.on("console", (m) => m.type() === "error" && console.log("console error:", m.text()));
await page.goto(url);
let t = Date.now();
await page.setInputFiles(statSync(path).isDirectory() ? "#folder-input" : "#file-input", path);
await page.waitForSelector("#app:not([hidden])", { timeout: 600000 });
await page.waitForSelector("#busy", { state: "hidden" });
console.log(`loaded ${(Date.now() - t) / 1000}s`);
t = Date.now();
await page.waitForFunction(() => document.querySelectorAll(".zoom canvas").length >= 8, null, { timeout: 600000 });
console.log(`4 automatic zooms in ${(Date.now() - t) / 1000}s:`, await page.$$eval(".zoom-head b", (e) => e.map((x) => x.textContent).join(" | ")));
console.log("zoom meta:", await page.$eval(".zoom-meta", (e) => e.textContent));
// click the middle of the axial view
const box = await page.$eval(".view:nth-child(3) canvas", (c) => { const r = c.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
await page.mouse.click(box[0], box[1]);
t = Date.now();
await page.waitForFunction(() => document.querySelectorAll(".zoom canvas").length >= 10, null, { timeout: 600000 });
console.log(`clicked zoom in ${(Date.now() - t) / 1000}s`);
console.log("metrics:", (await page.$eval("#metrics-panel table", (e) => e.innerText)).replace(/\n/g, " | ").slice(0, 600));
await page.waitForFunction(() => document.querySelectorAll("#metrics-panel table").length >= 2, null, { timeout: 60000 }).catch(() => console.log("no correlation table"));
console.log("psf plan:", await page.textContent("#psf-panel .zoom-controls .hint"));
t = Date.now();
await page.click("#psf-panel button");
await page.waitForSelector("#psf-panel .psf-results", { timeout: 900000 });
console.log(`psf in ${(Date.now() - t) / 1000}s:`, (await page.$eval("#psf-panel .psf-results table", (e) => e.innerText)).replace(/\n/g, " | "));
// slices mode for zooms, and window change
await page.click('input[name="zoom-mode"][value="slice"]');
await page.$eval(".zoom-controls input[type=range]", (e) => { e.value = String(Number(e.max) * 0.05); e.dispatchEvent(new Event("input")); });
await page.screenshot({ path: out, fullPage: true });
await browser.close();
