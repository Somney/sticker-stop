# Sticker Stop ✂

Turn a video of yourself dancing into **numbered cutout stickers** for a stop-motion animation, laid out and
ready to print + cut on a **Cricut StickerPix Print + Cut** (or any Cricut Print Then Cut machine).

Everything runs in your browser. Your video never leaves your device.

## What it does

1. **Source:** upload a video (or a batch of photos), or use the **live camera** with a countdown. It
   records at your chosen frame rate and cuts each frame out automatically while you dance.
2. **Cutout:**
   - **Green screen key:** pick the colour (click the preview, or use *Auto-detect*). Sliders cover tolerance,
     edge softness, green-spill removal and edge choke.
   - **AI auto:** person segmentation (MediaPipe selfie segmenter), so no green screen is needed.
   - **Green screen + AI:** the cleanest option. The AI ignores lights and stands past the edge of the screen,
     and the key gives crisp edges.
   - Stray specks are removed so each frame is exactly one sticker.
3. **Frame rate:** choose 6 / 8 / 10 / **12** / 15 / 24 stickers per second. The app estimates the sticker and
   sheet count before you start.
4. **Frames:** a numbered gallery. Click a frame to skip it, then play the animation back or save a preview video.
5. **Sticker sheets:** pick the machine/paper. Every sticker gets a white offset border (the cut line) and a
   **frame number badge in the corner**, fused to the border so it's cut out with the sticker. The app packs
   the stickers in order, tells you **how many fit per sheet** and how many sheets you need, and exports
   300 dpi transparent PNGs.

The dancer is scaled the **same amount on every sticker**, based on the tallest pose. That keeps the animation
from "breathing" in size between frames.

## Research notes

### Cricut StickerPix Print + Cut: paper size
| | |
|---|---|
| Sticker sheet | **4 × 7 in** nominal. Cricut lists the usable size as **3.94 × 6.93 in (100 × 176 mm)** |
| Also takes | 4 × 6 in photo paper (for photos, not stickers) |
| Print | dye-sublimation, ~300 dpi (Cricut's figure), laminated, kiss-cut around your design |
| Files | via Cricut Design Space; a PNG with a transparent background tells it where to cut |

Default preset: the 3.94 × 6.93 in sheet with a 0.12 in safety margin. *Auto* orientation tries portrait and
landscape and keeps whichever fits more stickers. With a 1.5 in tall dancer, that's about 10–12 stickers per sheet.

For other Cricut machines (Explore / Maker / Joy Xtra), the classic Print Then Cut maximum image is
**6.75 × 9.25 in** on Letter/A4. Newer firmware allows more, so check the size indicator in Design Space. There's
also a *Custom* preset.

> Cricut only sells StickerPix sheets as Cricut-branded consumables, and its help pages couldn't be fetched while
> this was built. Double-check the margin against the template in Design Space the first time you print, and
> adjust **Sheet margin** if needed.

### Frames needed for smooth stop motion
- **12 fps ("on twos")** is the standard for hand-made stop motion and animation: one photo held for 2 frames
  of 24 fps video. It's the default here.
- **8 fps ("on threes")** is about the lowest that still reads as fluid motion.
- **6 fps** gives a deliberately choppy, jerky look.
- **15 fps** is common among brickfilmers and is noticeably smoother. **24 fps** is fully smooth but doubles the sticker count.
- Rule of thumb: **stickers = seconds of dance × fps.** A 5-second dance at 12 fps is 60 stickers, or about 5–6 StickerPix sheets.

## Install it as an app

Sticker Stop is a **Progressive Web App**. Once it's hosted, you can install it like a normal app:

- **iPhone / iPad (Safari):** Share → **Add to Home Screen**
- **Android (Chrome):** tap **Install** in the app bar (or ⋮ → Install app)
- **Mac / Windows (Chrome, Edge):** click **Install** in the app bar, or use the install icon in the address bar

When installed, it:
- runs full-screen with its own icon, one screen per step, and a bottom tab bar on phones
- **works offline**. The AI model is cached after its first use, so AI mode works offline after that too
- **auto-saves your project** (frames + settings) on the device, so you can close it and carry on later
- can **Share** sheets straight to the Cricut Design Space app or Photos/Files on a phone
- keeps the screen awake while recording

### Hosting (one-time)
The camera and installing both need HTTPS. The easiest option is **GitHub Pages**: repo Settings → Pages → *Deploy from a
branch* → pick this branch and `/ (root)`. Your app will be at `https://<user>.github.io/sticker-stop/`. Open
that link on your phone and install it.

Any static host works too (Netlify, Vercel, Cloudflare Pages). There's no build step.

### Local development
```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

## Printing with Cricut Design Space

1. **Download print-ready sheets.** Unzip it to get `sheet-NN_frames-A-B_WxHin.png` files plus `SIZES.txt`.
2. Design Space → New project → choose your StickerPix (or Print Then Cut) machine.
3. **Upload** → choose the sheet PNG → **Print Then Cut image**.
4. Lock proportions and set the size from `SIZES.txt`. Design Space trims the transparent edges on upload, so use
   the **sticker area** size listed.
5. **Make It** → print → cut. Peel the stickers in number order.

Prefer to arrange the stickers yourself? **Download individual stickers** gives one PNG per frame, with sizes listed.

## Shooting tips
- Keep the camera locked off (on a tripod) and shoot your **whole body**, with some floor showing.
- Light the green screen evenly and separately from yourself. Don't wear green, and stand 3–6 ft in front of the screen.
- Make big, clear poses. Small stickers can't show fine details like fingers well.
- Avoid loose hair or fringe, which turn into fragile cut lines. Raise the **White border** if cuts look fiddly.

## Files
```
index.html         app shell (5 screens + tab bar)
manifest.webmanifest, sw.js, icons/   installable PWA + offline cache
css/style.css      styles (light/dark, phone + desktop)
js/app.js          app wiring: navigation, sources, capture, gallery, sheets, export, install
js/store.js        on-device project storage (IndexedDB)
js/keyer.js        chroma key + spill suppression + backdrop auto-detect
js/segmenter.js    MediaPipe person segmentation (lazy-loaded)
js/processor.js    frame → cropped transparent cutout
js/mask.js         distance transform, speck removal, hole filling
js/sticker.js      offset border (cut line) + number badge
js/layout.js       sheet presets + in-order packing
js/export.js       300-dpi PNG (pHYs), zip, WebM preview
js/vendor/         JSZip 3.10.1 (MIT)
```
