# SPIM QC (prototype)

Browser tool for microscope operators: drop a lightsheet image, check it, set its
orientation, and save a QC JSON. Files are read locally (h5wasm in a Web Worker,
mounted with WORKERFS, so only the needed chunks are read) and never uploaded.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # orientation unit tests
npm run build      # static site in dist/
```

Supported so far: Imaris `.ims`. OME-Zarr is planned.

## Orientation

`OrientationStringXYZ` as in SPIMquant / zarrnii: one letter per image axis X, Y, Z
(X = last array axis) for the direction it increases towards. Views are drawn in
neurological convention with labelled edges; the rotate buttons keep handedness,
and mirroring is a separate, confirmed step, since a mirrored brain looks normal.

The starting preset is chosen from what wrote the file
(`DataSetInfo/ImarisDataSet` `Creator`):

| Written by | Preset |
|---|---|
| Imaris Stitcher / Viewer | `RAI` |
| ImarisConvert (single Blaze tile) | `RPI` |

Based on two files of one brain (`/nfs/trident3/lightsheet/khan/test_mind_{1x,4x}`).

## Checking without a browser

```bash
npx tsx scripts/render-views.ts file.ims RAI out.png [channel]   # the three views as a PNG
node scripts/browser-smoke.mjs http://localhost:4173 file.ims out.png  # headless Chromium, after `npx vite preview`
```
