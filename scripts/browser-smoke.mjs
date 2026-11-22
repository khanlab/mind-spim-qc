// End-to-end check in headless Chromium: open an .ims through the worker, render, screenshot.
//   node scripts/browser-smoke.mjs http://localhost:4173 file.ims out.png
import { chromium } from "playwright-core";
const [url, file, out] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on("console", (m) => console.log("console:", m.text()));
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(url);
const t0 = Date.now();
await page.setInputFiles("#file-input", file);
await page.waitForFunction(() => /Read in|error/i.test(document.getElementById("read-status")?.textContent + document.getElementById("status")?.textContent), null, { timeout: 300000 });
console.log("status:", await page.textContent("#read-status"), "|", await page.textContent("#status"), `| ${(Date.now() - t0) / 1000}s total`);
console.log("orientation:", await page.inputValue("#orientation"), "preset:", await page.inputValue("#preset"));
await page.screenshot({ path: out });
await page.click('[data-rot="S,1"]');
console.log("after turn about S:", await page.inputValue("#orientation"));
await page.screenshot({ path: out.replace(".png", "_rot.png") });
await browser.close();
