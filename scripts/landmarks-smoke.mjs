// The steps on one page, in headless Chromium:
//   1 open the image, confirm the orientation
//   2 align the template (automatic), accept
//   load a template protocol -> 3 annotate: start, place a point, export
//   back to 2: nudge, accept -> landmarks re-placed; reset view; a subject protocol too
//   node scripts/landmarks-smoke.mjs BASE_URL image.ims template_protocol.json [subject_protocol.json] outdir
import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright-core";
const args = process.argv.slice(2);
const [base, image, tplProtocol] = args;
const outdir = args[args.length - 1];
const subjProtocol = args.length > 4 ? args[3] : null;
mkdirSync(outdir, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1100 }, deviceScaleFactor: 1, acceptDownloads: true });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
page.on("console", (m) => m.type() === "error" && console.log("console:", m.text()));
const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;

// 1. check and orientation
await page.goto(base + "/index.html");
await page.setInputFiles("#file-input", image);
await page.waitForSelector("#stepbar:not([hidden])", { timeout: 900000 });
console.log(`[${secs()}] step 1: orientation ${await page.inputValue("#orientation")}`);
if (!(await page.isChecked("#confirmed"))) await page.check("#confirmed");
await page.click("#next-step");

// 2. align
const aligned = () =>
  page.waitForFunction(() => /Done in|failed|saved alignment/i.test(document.getElementById("align-status").textContent ?? ""), null, { timeout: 600000 });
await aligned();
console.log(`[${secs()}] step 2: ${await page.textContent("#align-status")} | ${await page.textContent("#align-info")} | channel ${await page.inputValue("#align-channel")}`);
await page.screenshot({ path: `${outdir}/02_align.png` });
await page.click("#align-accept");
console.log(`[${secs()}] after accept, step: ${await page.$eval("#stepbar .current", (b) => b.dataset.step)}`);

// load a template protocol -> 3
await page.setInputFiles("#protocol-input", tplProtocol);
await page.waitForSelector("#annotate:not([hidden])");
console.log(`[${secs()}] step 3: ${await page.textContent("#annotate-protocol")} | orientation: ${await page.textContent("#annotate-orientation")} | alignment: ${await page.textContent("#annotate-alignment")}`);
await page.fill("#rater", "smoke");
await page.click("#start");
const readDone = () => page.waitForFunction(() => / read in /.test(document.getElementById("lm-status").textContent ?? ""), null, { timeout: 300000 });
await readDone();
console.log(`[${secs()}] ${await page.textContent("#lm-title")}: ${await page.textContent("#lm-status")}`);
const canvas = async (i) => (await page.$$("#lm-views canvas"))[i];
let c = await canvas(0);
let b = await c.boundingBox();
await page.mouse.click(b.x + b.width * 0.5, b.y + b.height * 0.5);
await page.keyboard.press("Space");
console.log(`[${secs()}] placed: ${await page.textContent("#progress")}`);
await page.screenshot({ path: `${outdir}/03_annotate.png` });
const before = await page.textContent("#lm-title");

// back to 2: nudge and accept -> landmarks re-placed, back in 3
await page.click("#realign");
await page.waitForSelector("#align:not([hidden])");
await page.click('#align-controls button:has-text("A") >> nth=0');
await page.evaluate(() => (document.getElementById("lm-status").textContent = ""));
await page.click("#align-accept");
await page.waitForSelector("#annotate-app:not([hidden])");
await readDone();
console.log(`[${secs()}] re-aligned: on ${await page.textContent("#lm-title")} (was ${before}), ${await page.textContent("#progress")}`);

// reset view
c = await canvas(0);
b = await c.boundingBox();
await page.mouse.dblclick(b.x + b.width * 0.85, b.y + b.height * 0.85);
await page.waitForTimeout(1500);
await page.keyboard.press("r");
await page.waitForTimeout(1500);
console.log(`[${secs()}] reset view: field ${await page.inputValue("#fov")}`);

// export
const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#export-tsv")]);
await dl.saveAs(`${outdir}/${dl.suggestedFilename()}`);
console.log(`[${secs()}] exported ${dl.suggestedFilename()}:`);
console.log(readFileSync(`${outdir}/${dl.suggestedFilename()}`, "utf8").trim().split("\n").slice(0, 2).join("\n"));

// a subject protocol (positions for this image) needs no alignment
if (subjProtocol) {
  await page.setInputFiles("#protocol-input", subjProtocol);
  await page.waitForSelector("#annotate-start:not([hidden])");
  console.log(`[${secs()}] subject protocol: ${await page.textContent("#annotate-alignment")}`);
  await page.click("#start");
  await page.evaluate(() => (document.getElementById("lm-status").textContent = ""));
  await readDone();
  console.log(`[${secs()}] ${await page.textContent("#lm-title")}: ${await page.textContent("#lm-status")}`);
}
await browser.close();
