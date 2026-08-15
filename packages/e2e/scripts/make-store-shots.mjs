#!/usr/bin/env node
/**
 * Composite raw wallet screenshots into per-store listing images.
 *
 * Capture and composition are separate on purpose: re-wording a headline should
 * never mean re-driving a browser, and the raw frames stay reusable for the
 * site, docs and press. `tests/marketing-shots.spec.ts` produces the raw PNGs;
 * this turns them into the exact canvases each store demands.
 *
 *   MARKETING_SHOTS=1 npx playwright test tests/marketing-shots.spec.ts
 *   node scripts/make-store-shots.mjs
 *   node scripts/make-store-shots.mjs --promote     # copy to Marketing Media
 *
 * Sizes are the stores' REQUIRED dimensions, not approximations:
 *   chrome  1280x800   Chrome Web Store screenshot (also fine for AMO)
 *   ios67   1290x2796  App Store 6.7" (iPhone 15/16 Pro Max) — required tier
 *   ios65   1242x2688  App Store 6.5" — still required for older device support
 *   play    1080x1920  Google Play phone screenshot (min 320, 16:9 portrait)
 *
 * Every canvas is generated from the SAME raw frame, so the stores cannot drift
 * apart. Anything rejected by a store is a bug here, not a re-shoot.
 *
 * Uses ImageMagick (`magick`), which is already on the workstation. No new
 * dependency, and it is scriptable in CI later.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HOME = process.env.HOME ?? '/tmp';
const RAW = process.env.MARKETING_OUT ?? join(HOME, 'Build', 'smirk-marketing', 'raw');
const OUT = process.env.MARKETING_STORE_OUT ?? join(HOME, 'Build', 'smirk-marketing', 'store');
/** Approved deliverables only (workstation storage contract rule 5). */
const PROMOTE_DIR = join(HOME, 'Seafile', 'Marketing Media', 'smirk-wallet', 'v0.3.0');

const BRAND = {
  bg: '#0d0b14',
  accent: '#f5c542',
  fg: '#ffffff',
  muted: '#a99fc4',
};

/**
 * Headline + subhead per frame. Kept here rather than in the spec so copy can be
 * revised without a capture run.
 *
 * Written as claims the product actually makes. "Your keys, your node" is only
 * on the frame that literally shows the backend picker, because a store listing
 * that overpromises is the fastest way to a one-star review.
 */
const CAPTIONS = {
  '01-home-balances': {
    head: 'Five chains. One wallet.',
    sub: 'Bitcoin, Litecoin, Monero, Wownero and Grin, with a live fiat total.',
  },
  // NOT "a fresh address every time". Per-payment subaddress issuance ships
  // dark in v0.3.0 (ENABLE_SUBADDRESS_RECEIVE_DEFAULT = false), so the button
  // is not in the frame and a store visitor cannot use it. Describe the screen.
  '02-receive-xmr': {
    head: 'Receive on any chain',
    sub: 'A clean address per asset, with an optional amount request.',
  },
  '03-send-btc': {
    head: 'Send without an account',
    sub: 'No signup, no KYC, no custody. Your keys never leave your device.',
  },
  // NOT "without handing funds to an exchange". The frame's own copy says the
  // live route (Trocador) is "non-custodial-for-Smirk but custodial for the
  // underlying provider", and the trust-minimized routes are badged SOON. A
  // caption a reader can disprove by looking at the picture is worse than none.
  '04-swap': {
    head: 'Swap between chains',
    sub: 'Compare routes and pick the trust model you want for each trade.',
  },
  '05-inbox': {
    head: 'Tips and encrypted messages',
    sub: 'Send value or a private note over Nostr, end-to-end encrypted.',
  },
  // NOT "one name, everywhere / get paid by name". The smoke wallet has no
  // handle claimed, so that headline sat directly above a panel reading "No
  // Smirk handle is claimed". Either claim a handle on the capture wallet and
  // restore the stronger copy, or describe the identity vault that is actually
  // on screen. This is the latter.
  '06-nostr-identity': {
    head: 'A Nostr identity from your seed',
    sub: 'Switch between your seed account, throwaway burners and imported keys.',
  },
  '07-self-host-backend': {
    head: 'Run your own backend',
    sub: 'Point the wallet at your own server and send us nothing at all.',
  },
  '08-settings': { head: 'Yours to configure', sub: 'Auto-lock, address privacy, chains, backend.' },
  // The frame shows the panel in its EMPTY state, because the capture wallet has
  // never connected to a site. So the caption describes the control rather than
  // a list of sites: everything it claims is written in the panel's own copy on
  // screen ("it shows up here, and you can take its access back at any time").
  // This is the frame that answers the <all_urls> question a store reviewer
  // actually asks, so it must not overreach.
  '09-connected-sites': {
    head: 'Revoke any site, any time',
    sub: 'Sites reach nothing without your approval, and you can withdraw it.',
  },
};

/**
 * `src` names the capture variant a target is built from. The extension stores
 * show the real 380x600 popup, because that is literally what installing gives
 * you. The mobile stores show the phone-shaped pass: a popup frame is aspect
 * 0.63 against a 0.46 iPhone canvas, so it cannot fill one at any scale and
 * leaves a dead band down the middle.
 */
const TARGETS = [
  { name: 'chrome', w: 1280, h: 800, layout: 'landscape', src: 'popup' },
  { name: 'ios67', w: 1290, h: 2796, layout: 'portrait', src: 'phone' },
  { name: 'ios65', w: 1242, h: 2688, layout: 'portrait', src: 'phone' },
  { name: 'play', w: 1080, h: 1920, layout: 'portrait', src: 'phone' },
];

function magick(args) {
  execFileSync('magick', args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

/** Pixel height of an already-rendered image. */
function heightOf(file) {
  return Number(
    execFileSync('magick', ['identify', '-format', '%h', file], { encoding: 'utf8' }).trim(),
  );
}

const SCRATCH = join(tmpdir(), 'smirk-store-shots');

/**
 * One canvas. Portrait puts the headline above a large device shot; landscape
 * (Chrome) puts text left, device right, because a 1280x800 frame is too short
 * to stack a phone-shaped screenshot under a headline without shrinking it to
 * uselessness.
 */
function compose(rawFile, target, caption, outFile) {
  const { w, h, layout } = target;
  const pad = Math.round(w * 0.06);

  // Captions render into a FIXED-WIDTH box via `caption:`, which wraps.
  // `-annotate` does not wrap: a long subhead ran off the canvas edge, and in
  // landscape it printed straight through the device image.
  //
  // Head and sub are appended into ONE block before compositing, rather than
  // placed at two computed offsets. A headline that wraps to two lines changes
  // height, and fixed offsets then either collide with the subhead or leave a
  // gap; `-append` makes the spacing correct whatever the copy does.
  //
  // `-gravity` inside the parens sets TEXT alignment (ragged-right when west);
  // without it `caption:` justifies, which stranded a lone word on its own line.
  const textStack = (boxW, headPt, subPt, align, gapPx) => [
    '(',
    '(', '-background', 'none', '-fill', BRAND.fg, '-gravity', align,
    '-pointsize', String(headPt), '-size', `${boxW}x`, `caption:${caption.head}`, ')',
    '(', '-size', `${boxW}x${gapPx}`, 'xc:none', ')',
    '(', '-background', 'none', '-fill', BRAND.muted, '-gravity', align,
    '-pointsize', String(subPt), '-size', `${boxW}x`, `caption:${caption.sub}`, ')',
    '-append', ')',
  ];

  if (layout === 'portrait') {
    // Text owns the top band, the device takes ALL the room left under it.
    //
    // The device height used to be a fixed fraction of the canvas (0.62), which
    // left a dead band through the middle: the caption ended around 18% and the
    // shot did not begin until 38%. A fixed fraction cannot be right for both
    // canvases anyway, since Play is 16:9 and the iPhone tiers are far taller,
    // so the same fraction leaves a different hole in each.
    //
    // So measure instead of guess: render the caption, read its actual height,
    // and give the device everything below it. Copy that wraps to a third line
    // now shrinks the device rather than colliding with it.
    const headPt = Math.round(w * 0.060);
    const subPt = Math.round(w * 0.030);
    const boxW = w - pad * 2;
    const top = Math.round(h * 0.045);
    const gap = Math.round(h * 0.02);

    mkdirSync(SCRATCH, { recursive: true });
    const textFile = join(SCRATCH, `${target.name}-text.png`);
    magick([...textStack(boxW, headPt, subPt, 'center', Math.round(subPt * 0.9)), textFile]);

    // Fit inside BOTH bounds (`-resize WxH` never exceeds either), so the shot
    // is as large as the canvas allows and is never cropped.
    const availH = h - (top + heightOf(textFile) + gap);
    const availW = w - pad * 2;

    magick([
      '-size', `${w}x${h}`, `xc:${BRAND.bg}`,
      '(', rawFile, '-resize', `${availW}x${availH}`, ')',
      '-gravity', 'south', '-geometry', '+0+0', '-composite',
      textFile, '-gravity', 'north', '-geometry', `+0+${top}`, '-composite',
      outFile,
    ]);
    return;
  }

  // Landscape: device pinned right, text confined to the left column so the two
  // can never overlap however long the copy gets.
  const shotH = Math.round(h * 0.92);
  const headPt = Math.round(w * 0.040);
  const subPt = Math.round(w * 0.021);
  const colW = Math.round(w * 0.50);
  magick([
    '-size', `${w}x${h}`, `xc:${BRAND.bg}`,
    '(', rawFile, '-resize', `x${shotH}`, ')',
    '-gravity', 'east', '-geometry', `+${pad}+0`, '-composite',
    ...textStack(colW, headPt, subPt, 'west', Math.round(subPt * 1.1)),
    '-gravity', 'west', '-geometry', `+${pad}+0`, '-composite',
    outFile,
  ]);
}

/** Frames for one capture variant, or a null telling the caller what to run. */
function framesFor(variant) {
  const dir = join(RAW, variant);
  if (!existsSync(dir)) return null;
  const frames = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
  return frames.length ? frames : null;
}

function main() {
  const sources = {};
  for (const variant of [...new Set(TARGETS.map((t) => t.src))]) {
    const frames = framesFor(variant);
    if (!frames) {
      // Fail rather than quietly building half a listing: a store page missing
      // its phone screenshots is worse than one that was never built.
      const env = variant === 'phone' ? 'MARKETING_VARIANT=phone ' : '';
      console.error(
        `No ${variant} captures at ${join(RAW, variant)}.\n` +
          `Run: MARKETING_SHOTS=1 ${env}npx playwright test tests/marketing-shots.spec.ts`,
      );
      process.exit(1);
    }
    sources[variant] = frames;
  }

  let made = 0;
  const skipped = [];
  for (const target of TARGETS) {
    const dir = join(OUT, target.name);
    mkdirSync(dir, { recursive: true });
    for (const frame of sources[target.src]) {
      const key = frame.replace(/\.png$/, '');
      const caption = CAPTIONS[key];
      if (!caption) {
        // Loudly, not silently: an uncaptioned frame means the spec captured
        // something the copy has not caught up with.
        skipped.push(key);
        continue;
      }
      compose(join(RAW, target.src, frame), target, caption, join(dir, `${key}.png`));
      made++;
    }
  }

  rmSync(SCRATCH, { recursive: true, force: true });

  console.log(`\nBuilt ${made} store images across ${TARGETS.length} targets → ${OUT}`);
  for (const t of TARGETS) console.log(`  ${t.name.padEnd(8)} ${t.w}x${t.h}  from ${t.src}`);
  if (skipped.length) {
    console.log(`\nNO CAPTION, so not built: ${skipped.join(', ')}`);
    console.log('Add them to CAPTIONS in this script, or drop the frame from the spec.');
  }

  if (process.argv.includes('--promote')) {
    mkdirSync(PROMOTE_DIR, { recursive: true });
    for (const t of TARGETS) {
      const src = join(OUT, t.name);
      const dst = join(PROMOTE_DIR, t.name);
      mkdirSync(dst, { recursive: true });
      for (const f of readdirSync(src)) copyFileSync(join(src, f), join(dst, f));
    }
    console.log(`\nPromoted to ${PROMOTE_DIR}`);
    console.log('Marketing Media holds APPROVED deliverables — only promote what has been reviewed.');
  } else {
    console.log('\n--promote copies these to Marketing Media (approved deliverables only).');
  }
}

main();
