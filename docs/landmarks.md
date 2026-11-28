# Template alignment and landmark annotation

The QC page works in steps on the one open image (the file is chosen once):

1. **Check and orientation**: the QC views. Confirm the orientation ("I checked the
   orientation"); it is kept in this browser for the image and filled in next time.
2. **Align template**: an affine alignment of the ABAv3 template to the image
   (about 10 s). Check the outline (magenta template edges, yellow template brain)
   and nudge it with the turn (5°), move (0.1 mm, shift 0.5 mm) and size (2 %)
   buttons; "Refine from here" searches again from the nudged position; Accept.
   Align on a channel showing the anatomy (nuclear stain or autofluorescence): the
   page picks one by stain name, else the channel whose signal covers the most of
   the brain. Left-right cannot be judged from the fit, so the orientation must come
   from the acquisition. Accepted alignments are kept per image (file name and size).
3. **Annotate**: appears once a landmark **protocol** (`.json`, from
   spimquant-fiducials) is loaded ("Load protocol", or drop it on the page). A
   template protocol uses the orientation from step 1 and the alignment from step 2;
   a protocol made for this image needs neither. Enter your initials and a session
   number and Start. The alignment only starts each landmark view near its place: a
   few hundred µm off is fine; "Re-align template" goes back to step 2, and an
   accepted change moves the starting positions (placements are kept).

Starting positions are not marked (tick "show start position" to see them).

In step 3, for each landmark: read the definition, compare with the template thumbnail,
   click the views to move the cursor, and press **Space** to place it.
   Mark **Absent** or **Damaged** if it cannot be placed.
When done, save placements: `<image>_desc-<rater>_landmarks.tsv` and its `.json`
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
