# SPIM QC: guide for microscopists

SPIM QC checks a lightsheet image right after acquisition and records its
orientation, before the data is uploaded and processed. It runs in the web
browser; **the image is read on your computer and is never uploaded.**

Use a recent Chrome, Edge or Firefox. Chrome and Edge can also open OME-Zarr
folders with the "Choose OME-Zarr folder" button; in Firefox, drag the folder
onto the page instead.

## 1. Open an image

Drag one of these onto the page, or use the buttons:

- an Imaris file (`.ims`)
- an OME-Zarr folder (`.ome.zarr`)
- a zipped OME-Zarr (`.ozx`)

A progress bar shows while the overview is read (a few seconds to a minute,
depending on the image and the disk). Large files are fine: only a small part
of the file is read.

## 2. Check and set the orientation

Three views (coronal, sagittal, axial) show the brain with the anatomical
directions labelled around each view (L/R, A/P, S/I). The brain should look
like this:

- **olfactory bulbs at A** (anterior), **cerebellum at P** (posterior)
- **the top of the cortex at S** (superior)

The starting orientation comes from the file, or from what wrote it. If the
brain does not match the labels, turn it with the arrow buttons (about the
left-right, anterior-posterior or superior-inferior axis) until it does. The
three letters (e.g. `RAI`) update as you turn; they are what the processing
pipeline needs.

**Left and right cannot be seen in the image**: a mirrored brain looks
normal. Only use "Mirror left-right" if you know this acquisition writes
mirrored images.

When the views look right, tick **I checked the orientation**.

Name the channels (stains) if the file does not, e.g. `YoPro`, `Abeta`, `CD31`.

## 3. Look at the image quality

Below the views:

- **Full-resolution zooms** of the brightest and dimmest places in the tissue.
  Click anywhere on a view to add a zoom there. Each shows the imaging plane
  (x-y) and a cut through depth (x-z). Choose the channel, switch between
  projections and slices, and set the black and white levels (shared by all
  zooms, so brightness can be compared). Look for blur, stripes, saturation
  (white, flat areas) and stitching seams. Each zoom gives its sharpness and
  the fraction of saturated pixels.
- **Metrics** for each channel: signal-to-noise ratio, contrast, how much the
  intensity changes with depth or across the field, tissue volume, and how much
  of the tissue touches the edge of the image (cut off). Values worth a look are
  shown in yellow; hover a name for its definition.
- **Resolution (experimental)**: press **Estimate** to measure how wide small
  bright spots are along x-y and along z at a few places in the tissue, and how
  much extra blur there is along z. Use a nuclear stain if there is one. The
  numbers are most useful compared with earlier scans of the same stain: a rise
  in z blur points to a problem with the light sheet or the optics.

  **Left and right light sheets.** By default the tissue is split at its
  midline along the image x axis (the dashed line on the views), and each side
  is measured separately (points `a…` on the low-x side, `b…` on the high-x
  side). If one side is clearly blurrier along z, a message says so: the light
  sheet on that side may be out of alignment. Choose "along y" if your sheets
  travel along y, or "no" to measure the whole tissue. "Low x" and "high x" are
  sides of the image; which laser lights which side depends on the microscope.

## 4. Rate and save

Rate the scan **pass**, **check** or **fail**, add a note, and press
**Save QC (JSON)**. Keep the saved file with the data: it holds the
orientation, the channel names, the voxel size, the rating and the metrics, and
is used when the data is packaged for upload.
