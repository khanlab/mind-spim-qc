// QC (confirm orientation) -> landmarks (prefilled orientation, align, accept) -> reopen (saved alignment) -> reset view.
//   node scripts/workflow-smoke.mjs BASE_URL template_protocol.json image.ims channel outdir
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
const [base, protocol, image, channel, outdir] = process.argv.slice(2);
mkdirSync(outdir, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1700, height: 1050 } });
const log = (p) => {
  p.on("pageerror", (e) => console.log("pageerror:", e.message));
  return p;
};

// 1. QC page
const qc = log(await ctx.newPage());
await qc.goto(base + "/index.html");
await qc.setInputFiles("#file-input", image);
await qc.waitForSelector("#app:not([hidden])", { timeout: 900000 });
console.log("QC orientation:", await qc.inputValue("#orientation"));
await qc.check("#confirmed");
console.log("QC note:", await qc.textContent("#orientation-note"), "| next step visible:", await qc.isVisible("#next-step"));
await qc.close();

// 2. landmark page, first time
const startLm = async (tag) => {
  const p = log(await ctx.newPage());
  await p.goto(base + "/landmarks.html");
  await p.setInputFiles("#protocol-input", protocol);
  await p.setInputFiles("#file-input", image);
  console.log(`${tag} prefilled orientation:`, await p.inputValue("#orientation"), "|", await p.textContent("#orient-note"));
  console.log(`${tag} alignment step:`, await p.textContent("#align-note"));
  if (!(await p.inputValue("#channel"))) await p.fill("#channel", channel);
  await p.fill("#rater", "wf");
  await p.click("#start");
  await p.waitForSelector("#align:not([hidden])", { timeout: 120000 });
  await p.waitForFunction(() => /Done in|failed|saved alignment/i.test(document.getElementById("align-status").textContent ?? ""), null, { timeout: 600000 });
  console.log(`${tag} align status:`, await p.textContent("#align-status"));
  return p;
};
let p = await startLm("first:");
await p.click('#align-controls button:has-text("A") >> nth=0'); // one nudge
await p.click("#align-accept");
await p.waitForSelector("#app:not([hidden])");
await p.close();

// 3. reopen: the saved alignment comes back
p = await startLm("again:");
console.log("again: info:", await p.textContent("#align-info"));
await p.click("#align-accept");
await p.waitForFunction(() => / read in /.test(document.getElementById("lm-status").textContent ?? ""), null, { timeout: 300000 });

// 4. move away, then reset view
const c = (await p.$$("#lm-views canvas"))[0];
const b = await c.boundingBox();
await p.mouse.dblclick(b.x + b.width * 0.85, b.y + b.height * 0.85);
await p.selectOption("#fov", "6400");
await p.dispatchEvent("#fov", "change");
await p.waitForTimeout(2000);
await p.screenshot({ path: `${outdir}/moved.png` });
await p.keyboard.press("r");
await p.waitForTimeout(500);
await p.waitForFunction(() => !/reading/.test(document.getElementById("lm-status").textContent ?? ""), null, { timeout: 300000 });
await p.waitForTimeout(800);
console.log("after reset: field", await p.inputValue("#fov"), "|", await p.textContent("#lm-status"));
await p.screenshot({ path: `${outdir}/reset.png` });
await browser.close();
