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

## Below the views

- **Full-resolution zooms**: the two brightest and two dimmest places in the
  tissue, and any place clicked on a view (the slice shown, or the brightest
  voxel along a projection). Each shows the x-y imaging plane and an x-z cut,
  as projections or slices, with black and white levels shared by the zooms of
  a channel, sharpness and saturated fraction. A zoom is read at the finest
  level whose chunks fit 1.5 GB (OME-Zarr with whole-plane chunks falls back to
  a coarser level).
- **Metrics** per channel, as in SPIMquant's QC: SNR, tissue/background,
  signal range, non-uniformity with depth and across the field, tissue volume,
  tissue at the edge of the image, and correlation between channels.
- **Resolution (experimental)**: full-resolution blocks at points spread through
  the tissue. Widths (FWHM) of small bright spots along x, y and z, the average
  spot, and the extra blur along z from the power spectra
  (`ln(Sz/Sxy) = c - (2 pi k)^2 (sz^2 - sxy^2)`, assuming isotropic structure).
  Tissue has few objects smaller than the PSF, so spot widths are upper bounds;
  compare scans of the same stain, ideally a nuclear one.

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
npx tsx scripts/psf-probe.ts <image> [points] [channels]   # metrics and resolution estimate
npx tsx scripts/zoom-probe.ts <image> [channel]            # zoom level, cost and timing
node scripts/browser-panels.mjs http://localhost:4173 <image> out.png  # headless check of the panels
npx tsx scripts/render-views.ts <image.ims|folder.ome.zarr> <RAI|file> out.png [channel]  # the three views as a PNG
node scripts/browser-smoke.mjs http://localhost:4173 <image> out.png  # headless Chromium, after `npx vite preview`
```
