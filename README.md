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

Reads Imaris `.ims` files, OME-Zarr folders (NGFF 0.4/0.5, dropped or chosen)
and `.ozx` (zipped OME-Zarr). The overview is read from the finest pyramid level
that fits 32M voxels per channel, stepping through axes much finer than the
others (some pyramids never downsample z). The worker computes the projections
along the three array axes once; the views of any orientation are flips and
transposes of these, so rotating is instant.

## Orientation

`OrientationStringXYZ` as in SPIMquant / zarrnii: one letter per image axis X, Y, Z
(X = last array axis) for the direction it increases towards. Views are drawn in
neurological convention with labelled edges; the rotate buttons keep handedness,
and mirroring is a separate, confirmed step, since a mirrored brain looks normal.

The views stay fixed (same boxes, labels and scale); only the brain turns
inside them.

The starting orientation is the one stored in the file if there is one (OME-Zarr
`xyz_orientation`, or the legacy `orientation` in Z, Y, X order, as zarrnii reads
them). Otherwise a preset is chosen from what wrote the file
(`DataSetInfo/ImarisDataSet` `Creator`):

| Written by | Preset |
|---|---|
| Imaris Stitcher / Viewer | `RAI` |
| ImarisConvert (single Blaze tile) | `RPI` |

Based on two files of one brain (`/nfs/trident3/lightsheet/khan/test_mind_{1x,4x}`).

## Checking without a browser

```bash
npx tsx scripts/render-views.ts <image.ims|folder.ome.zarr> <RAI|file> out.png [channel]  # the three views as a PNG
node scripts/browser-smoke.mjs http://localhost:4173 <image> out.png  # headless Chromium, after `npx vite preview`
```
