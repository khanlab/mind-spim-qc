// Template protocol end to end: align (automatic), nudge, accept, save the alignment, open landmarks.
//   node scripts/landmarks-align-smoke.mjs URL protocol.json image.ims channel orientation outdir
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
const [url, protocol, image, channel, orientation, outdir] = process.argv.slice(2);
mkdirSync(outdir, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1100 }, deviceScaleFactor: 1, acceptDownloads: true });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
page.on("console", (m) => m.type() === "error" && console.log("console:", m.text()));
await page.goto(url);
await page.setInputFiles("#protocol-input", protocol);
await page.setInputFiles("#file-input", image);
await page.fill("#channel", channel);
await page.fill("#orientation", orientation);
await page.fill("#rater", "smoke");
const t0 = Date.now();
await page.click("#start");
await page.waitForSelector("#align:not([hidden])", { timeout: 120000 });
await page.waitForFunction(() => /Done in|failed/.test(document.getElementById("align-status").textContent ?? ""), null, { timeout: 600000 });
console.log(`aligned after ${((Date.now() - t0) / 1000).toFixed(1)} s:`, await page.textContent("#align-status"));
console.log("info:", await page.textContent("#align-info"));
await page.screenshot({ path: `${outdir}/01_align.png` });
// nudge timing
const tn = Date.now();
await page.click('#align-controls button:has-text("↺ 5°") >> nth=1');
console.log(`nudge redraw ${Date.now() - tn} ms`);
await page.screenshot({ path: `${outdir}/02_nudged.png` });
await page.click('#align-controls button:has-text("↻ 5°") >> nth=1');
const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#align-save")]);
await dl.saveAs(`${outdir}/alignment.json`);
await page.click("#align-accept");
await page.waitForSelector("#app:not([hidden])", { timeout: 60000 });
await page.waitForFunction(() => / read in /.test(document.getElementById("lm-status").textContent ?? ""), null, { timeout: 300000 });
console.log("first landmark:", await page.textContent("#lm-title"), "|", await page.textContent("#lm-status"));
await page.screenshot({ path: `${outdir}/03_landmark.png` });
await browser.close();
