# Cowork only: parallel illustrations with host-ImageGenerate (core-RunScript)

Uses the `aether_tools` library that exists only inside Cowork's RunScript, so it is kept here as text.
GitHub Copilot / VS Code have no image generator: skip this step; `build_deck.py` puts the section icon on
the covers without an image (tell the user). The deck itself is ALWAYS built by `scripts/build_deck.py`.

## Illustrations in parallel (8 threads; ~70 images ≈ 160 s)
`working/deck/concepts.json` maps news id → one visual concept in English (see `assets/example-concepts.json`),
ONLY for the ids that `pick_images.py pick` reported as `needs_illustration` (no explanatory article image).
Create the folder first (`mkdir -p working/deck/images`). Output: `working/deck/images/<id>.png`, portrait 2:3 → `build_deck.py` shows it as a full-height right panel.
```python
from aether_tools import tools, set_result, log
import json, os, concurrent.futures as cf
C = json.load(open("working/deck/concepts.json"))
STYLE = ("Flat vector editorial illustration in Microsoft Fluent 2 style, rounded soft shapes, subtle gradients and soft glows, "
 "very dark lavender/navy background (#0F0A26) filling the whole image, palette violet #A371F7, blue #58A6FF, mint green #3FB950 "
 "and soft orange accents, purple accent, clean minimal composition, subject centered with breathing room. "
 "No text, no words, no letters, no numbers, no logos, no watermarks, no UI text, no photorealism.")
def go(k):
    fn = str(k)
    if os.path.exists(f"working/deck/images/{fn}.png"): return k, "exists"
    try:
        r = tools.host.ImageGenerate(prompt=f"Illustration that explains: {C[k]}. {STYLE}", aspect="2:3",
                                     size="standard", quality="medium", destination="working/deck/images", filename=fn)
        p = r.payload if isinstance(r.payload, dict) else {}
        return k, p.get("path") or str(r.payload)[:200]
    except Exception as e:
        return k, "ERR " + str(e)[:200]
res = {}
with cf.ThreadPoolExecutor(8) as ex:
    for k, v in ex.map(go, sorted(C, key=int)):
        res[k] = v; log(f"{k} {v}")
set_result(res)
```
Re-run only the ids that returned `ERR` (the `exists` check skips the others). Then set
`"image_kind": "generated"` on those records in `news.json` (it only picks the portrait layout; no caption or provenance note on the slides).
`build_deck.py` recompresses every image (≤ 1600 px, JPEG q82), so no resizing step is needed.
