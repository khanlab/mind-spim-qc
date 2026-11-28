# Landmark placement (landmarks.html)

Places registration-validation landmarks at full resolution. A protocol (JSON
from spimquant-fiducials `make_protocol.py`) lists the landmarks for one image,
their definitions, template thumbnails and starting positions. Starting positions
come from an affine fit, not the registration under test, and are not marked
(tick "show start position" to see them).

The steps for an image are: (1) check it and confirm its orientation on the QC
page, (2) align the template, (3) place the landmarks. What the QC page confirms
and the alignments you accept are kept in this browser per image (file name and
size) and filled in the next time.

1. Open `landmarks.html`, choose the protocol and the image (.ims, OME-Zarr folder or .ozx).
2. Enter your initials and a session number, then Start. For a **template protocol**
   (landmarks defined on the template, e.g. ABAv3) also give the channel to show and
   the image orientation (e.g. RPI) if the file does not store it.
3. Template protocols only: **align the template**. An automatic affine runs first
   (about 10 s); check the outline (magenta template edges, yellow template brain)
   and nudge it with the turn (5°), move (0.1 mm, shift 0.5 mm) and size (2 %)
   buttons, "Refine from here" to search again from the nudged position, then
   Accept. The alignment only starts each landmark view near its place: a few
   hundred µm off is fine. It is kept in the browser and saved with the placements;
   "Re-align template" in the side bar comes back to it.
4. For each landmark: read the definition, compare with the template thumbnail,
   click the views to move the cursor, and press **Space** to place it.
   Mark **Absent** or **Damaged** if it cannot be placed.
5. Save placements when done: `<image>_desc-<rater>_landmarks.tsv` and its `.json`
   sidecar, for a derivatives dataset (positions are level-0 voxel indices of the
   image). "Save for 3D Slicer" writes the same points as `.fcsv` and `.mrk.json`
   (RAS mm). Placements are also kept in the browser and
   come back for the same protocol, image, rater and session.

Views
- **3D points**: coronal, sagittal and axial views through the cursor. The wheel
  moves through slices; choose a smaller field (0.4 mm) for full resolution.
- **Barrels**: a flat view tangential to layer 4 with a cross-section beside it.
  Move the depth slider (or click the cross-section) until the barrels are sharp;
  use tilt to flatten the plane. Defaults: 40 µm slab, 12 µm smoothing.
- **Hippocampus, MOp/SSp border**: a locked plane; click within it. If the plane
  does not cut the anatomy as in the thumbnail, move it with "Plane offset"
  (±400 µm); the offset is saved with the placement.
- **Layer probes**: a locked plane with the pia at the top. Click pia, then select
  "3. WM" and click the white-matter boundary; "Suggest L4" proposes the densest
  nuclear band between them. Check it and press Space, or mark L4 absent.

Keys: Space place · A absent · D damaged · C centre · N/P next/previous · +/− field.
