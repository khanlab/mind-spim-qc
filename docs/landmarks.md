# Landmark placement (landmarks.html)

Places registration-validation landmarks at full resolution. A protocol (JSON
from spimquant-fiducials `make_protocol.py`) lists the landmarks for one image,
their definitions, template thumbnails and starting positions. Starting positions
come from an affine fit, not the registration under test, and are not marked
(tick "show start position" to see them).

1. Open `landmarks.html`, choose the protocol and the image (.ims, OME-Zarr folder or .ozx).
2. Enter your initials and a session number, then Start.
3. For each landmark: read the definition, compare with the template thumbnail,
   click the views to move the cursor, and press **Space** to place it.
   Mark **Absent** or **Damaged** if it cannot be placed.
4. Save placements (TSV) when done. Placements are also kept in the browser and
   come back for the same protocol, image, rater and session.

Views
- **3D points**: coronal, sagittal and axial views through the cursor. The wheel
  moves through slices; choose a smaller field (0.4 mm) for full resolution.
- **Barrels**: a flat view tangential to layer 4 with a cross-section beside it.
  Move the depth slider (or click the cross-section) until the barrels are sharp;
  use tilt to flatten the plane. Defaults: 40 µm slab, 12 µm smoothing.
- **Hippocampus, MOp/SSp border**: a locked coronal plane; click within it.
- **Layer probes**: a locked plane with the pia at the top. Click pia, then select
  "3. WM" and click the white-matter boundary; "Suggest L4" proposes the densest
  nuclear band between them. Check it and press Space, or mark L4 absent.

Keys: Space place · A absent · D damaged · C centre · N/P next/previous · +/− field.
