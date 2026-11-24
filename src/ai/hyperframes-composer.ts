/**
 * Deterministic HyperFrames composition authoring and static contract checks.
 *
 * HyperFrames (Apache-2.0, https://hyperframes.heygen.com) renders an HTML
 * composition to video by seeking one paused GSAP timeline frame by frame in
 * headless Chrome. This module only builds and checks HTML text: it never
 * touches the filesystem, spawns a process, or talks to Premiere.
 *
 * Contract implemented here (HyperFrames HTML schema):
 * - root element carries data-composition-id, data-start, data-width,
 *   data-height and data-duration (seconds);
 * - timed children carry id, class="clip", data-start, data-duration;
 * - exactly one finite paused GSAP timeline registered as
 *   window.__timelines[<composition id>];
 * - no wall clock, unseeded randomness, requestAnimationFrame, or infinite repeats.
 *
 * Every user string reaches the document only through HTML text escaping. CSS
 * values are validated against strict patterns, and no user string is ever
 * embedded in JavaScript.
 */

export const GSAP_CDN_URL = "https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js";
export const MAX_COMPOSITION_HTML_BYTES = 2 * 1024 * 1024;
export const MAX_CREDIT_LINES = 200;
export const MAX_TEXT_LENGTH = 400;

export const CINEMATIC_PRESET_IDS = [
  "cinematic_title_card",
  "lower_third",
  "letterbox_bars",
  "chapter_card",
  "kinetic_quote",
  "end_credits_roll",
  "film_texture_overlay",
  "light_leak_transition",
  "countdown_leader",
] as const;
export type CinematicPresetId = (typeof CINEMATIC_PRESET_IDS)[number];

export const RESOLUTION_PRESETS = {
  "landscape": { width: 1920, height: 1080 },
  "portrait": { width: 1080, height: 1920 },
  "square": { width: 1080, height: 1080 },
  "landscape-1440p": { width: 2560, height: 1440 },
  "landscape-4k": { width: 3840, height: 2160 },
  "portrait-4k": { width: 2160, height: 3840 },
  "dci-2k": { width: 2048, height: 1080 },
  "dci-4k": { width: 4096, height: 2160 },
} as const;
export type ResolutionPreset = keyof typeof RESOLUTION_PRESETS;

export const LETTERBOX_ASPECTS = [2.76, 2.39, 2.35, 2.2, 2.0, 1.9, 1.85] as const;

export interface PresetInfo {
  id: CinematicPresetId;
  title: string;
  use: string;
  fields: readonly string[];
  defaultDurationSeconds: number;
  alphaByDefault: boolean;
  registryAlternatives: readonly string[];
  premiereBlendMode?: string;
}

/** Built-in presets plus related HyperFrames registry slugs for `npx hyperframes add <slug>`. */
export const CINEMATIC_PRESETS: readonly PresetInfo[] = [
  { id: "cinematic_title_card", title: "Cinematic title card", use: "Opening title or film name: tracked-in serif title, thin accent rule, subtitle fade.", fields: ["title", "subtitle", "kicker"], defaultDurationSeconds: 6, alphaByDefault: false, registryAlternatives: ["titlecard-lockup", "titlecard-calm", "headline-slam"] },
  { id: "lower_third", title: "Lower third", use: "Name and role identification over interview or documentary footage.", fields: ["name", "role"], defaultDurationSeconds: 5, alphaByDefault: true, registryAlternatives: ["lt-clean-bar", "lt-mask-reveal", "lt-kicker-name", "lt-side-rule"] },
  { id: "letterbox_bars", title: "Animated letterbox bars", use: "Cinemascope bars that slide in to a target aspect ratio (2.39:1 default) over the full edit.", fields: [], defaultDurationSeconds: 10, alphaByDefault: true, registryAlternatives: [] },
  { id: "chapter_card", title: "Chapter card", use: "Documentary or long-form act break: chapter number plus title.", fields: ["kicker", "title"], defaultDurationSeconds: 4, alphaByDefault: false, registryAlternatives: ["titlecard-calm", "split-flap-board"] },
  { id: "kinetic_quote", title: "Kinetic quote", use: "Per-word rising pull quote or testimonial with attribution.", fields: ["quote", "subtitle"], defaultDurationSeconds: 6, alphaByDefault: true, registryAlternatives: ["per-word-rise", "marker-highlight", "morph-text"] },
  { id: "end_credits_roll", title: "End credits roll", use: "Vertical scrolling credits from role/name lines.", fields: ["title", "credits"], defaultDurationSeconds: 20, alphaByDefault: false, registryAlternatives: [] },
  { id: "film_texture_overlay", title: "Film texture overlay", use: "Vignette, seeded film grain, and gate weave rendered with alpha; place on the top track (Overlay or Soft Light blend).", fields: [], defaultDurationSeconds: 10, alphaByDefault: true, registryAlternatives: [], premiereBlendMode: "Overlay" },
  { id: "light_leak_transition", title: "Light leak transition", use: "Warm light sweep with alpha to bridge two shots; place above the cut (Screen blend).", fields: [], defaultDurationSeconds: 1.5, alphaByDefault: true, registryAlternatives: ["light-leak", "flash-through-white", "cinematic-zoom", "whip-pan"], premiereBlendMode: "Screen" },
  { id: "countdown_leader", title: "Film countdown leader", use: "Classic 3-2-1 academy-style leader with sweep, for openers or trailers.", fields: [], defaultDurationSeconds: 3, alphaByDefault: false, registryAlternatives: [] },
];

export interface CompositionText {
  title?: string;
  subtitle?: string;
  kicker?: string;
  name?: string;
  role?: string;
  quote?: string;
  credits?: Array<{ role?: string; name: string }>;
}

export interface CompositionPalette {
  background?: string;
  primary?: string;
  accent?: string;
}

export interface ComposeArgs {
  preset: CinematicPresetId;
  composition_id?: string;
  resolution?: ResolutionPreset;
  width?: number;
  height?: number;
  fps?: number;
  duration_seconds?: number;
  transparent?: boolean;
  text?: CompositionText;
  palette?: CompositionPalette;
  font_family?: string;
  letterbox_aspect?: number;
  grain_intensity?: number;
  seed?: number;
}

export interface ComposedComposition {
  preset: CinematicPresetId;
  compositionId: string;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  transparent: boolean;
  html: string;
  sizeBytes: number;
  recommendedRender: { format: "mov" | "mp4"; reason: string; cliArgs: string[] };
  premierePlacement: { trackHint: string; blendMode?: string; notes: string[] };
  lint: LintReport;
}

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FONT_FAMILY = /^[A-Za-z0-9][A-Za-z0-9 \-]{0,62}$/;
const COMPOSITION_ID = /^[a-z][a-z0-9_]{0,47}$/;

function fail(message: string): never {
  throw new Error(`INVALID_ARGUMENT: ${message}`);
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function text(value: unknown, field: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string") fail(`text.${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > MAX_TEXT_LENGTH) fail(`text.${field} must be at most ${MAX_TEXT_LENGTH} characters`);
  return trimmed;
}

function color(value: unknown, field: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !HEX_COLOR.test(value)) fail(`palette.${field} must be a hex color such as #d4a24c`);
  return value;
}

function finite(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) fail(`${field} must be a number from ${min} through ${max}`);
  return value;
}

function round(value: number, places = 3): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

/** Letterbox geometry for a target aspect inside a frame; bars are even pixel counts. */
export function letterboxGeometry(width: number, height: number, aspect: number) {
  const activeHeight = Math.min(height, Math.round(width / aspect / 2) * 2);
  const bar = Math.max(0, (height - activeHeight) / 2);
  return {
    aspect,
    activeHeightPx: activeHeight,
    barHeightPx: bar,
    cropTopPercent: round((bar / height) * 100, 4),
    cropBottomPercent: round((bar / height) * 100, 4),
  };
}

/** Linear congruential sequence so "random" grain is a pure function of the seed. */
function seededSequence(seed: number, count: number, min: number, max: number): number[] {
  let state = (Math.floor(seed) >>> 0) || 1;
  const values: number[] = [];
  for (let index = 0; index < count; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    values.push(round(min + (state / 4294967296) * (max - min), 2));
  }
  return values;
}

interface Built { css: string; body: string; script: string }

function buildPreset(preset: CinematicPresetId, ctx: {
  width: number; height: number; fps: number; duration: number; t: Required<Omit<CompositionText, "credits">> & { credits: Array<{ role: string; name: string }> };
  bg: string; primary: string; accent: string; font: string; aspect: number; grain: number; seed: number;
}): Built {
  const { width, height, duration, t, primary, accent, font } = ctx;
  const unit = Math.min(width, height) / 1080;
  const px = (value: number) => `${Math.round(value * unit)}px`;
  const out = Math.max(0.4, duration - 0.8);
  switch (preset) {
    case "cinematic_title_card":
      return {
        css: `#kicker{position:absolute;top:38%;width:100%;text-align:center;font:500 ${px(26)} '${font}',serif;letter-spacing:.6em;color:${accent};text-transform:uppercase}
#title{position:absolute;top:44%;width:100%;text-align:center;font:400 ${px(120)} '${font}',serif;letter-spacing:.35em;color:${primary}}
#rule{position:absolute;top:60%;left:35%;width:30%;height:${px(2)};background:${accent};transform-origin:50% 50%}
#subtitle{position:absolute;top:64%;width:100%;text-align:center;font:300 ${px(34)} '${font}',serif;letter-spacing:.2em;color:${primary};opacity:.85}`,
        body: `<div id="kicker" class="clip" data-start="0" data-duration="${duration}">${escapeHtml(t.kicker)}</div>
<div id="title" class="clip" data-start="0" data-duration="${duration}">${escapeHtml(t.title)}</div>
<div id="rule" class="clip" data-start="0" data-duration="${duration}"></div>
<div id="subtitle" class="clip" data-start="0" data-duration="${duration}">${escapeHtml(t.subtitle)}</div>`,
        script: `tl.fromTo("#title",{opacity:0,letterSpacing:"0.8em",filter:"blur(12px)"},{opacity:1,letterSpacing:"0.35em",filter:"blur(0px)",duration:2.2,ease:"power3.out"},0.3);
tl.fromTo("#rule",{scaleX:0},{scaleX:1,duration:1.2,ease:"expo.out"},1.2);
tl.fromTo("#kicker",{opacity:0,y:${Math.round(20 * unit)}},{opacity:1,y:0,duration:1,ease:"power2.out"},1.0);
tl.fromTo("#subtitle",{opacity:0,y:${Math.round(-16 * unit)}},{opacity:0.85,y:0,duration:1,ease:"power2.out"},1.6);
tl.to(["#title","#rule","#kicker","#subtitle"],{opacity:0,duration:0.8,ease:"power2.in"},${round(out)});`,
      };
    case "lower_third":
      return {
        css: `#lt{position:absolute;left:7%;bottom:14%;overflow:hidden;padding:${px(14)} ${px(28)} ${px(14)} ${px(24)}}
#lt-bar{position:absolute;left:0;top:0;bottom:0;width:${px(6)};background:${accent}}
#lt-name{font:600 ${px(54)} '${font}',sans-serif;color:${primary};letter-spacing:.02em}
#lt-role{font:400 ${px(30)} '${font}',sans-serif;color:${accent};letter-spacing:.18em;text-transform:uppercase;margin-top:${px(6)}}`,
        body: `<div id="lt" class="clip" data-start="0" data-duration="${duration}"><div id="lt-bar"></div><div id="lt-name">${escapeHtml(t.name)}</div><div id="lt-role">${escapeHtml(t.role)}</div></div>`,
        script: `tl.fromTo("#lt-bar",{scaleY:0},{scaleY:1,transformOrigin:"50% 100%",duration:0.45,ease:"power3.out"},0.2);
tl.fromTo("#lt-name",{x:${Math.round(-60 * unit)},opacity:0},{x:0,opacity:1,duration:0.7,ease:"power3.out"},0.45);
tl.fromTo("#lt-role",{x:${Math.round(-40 * unit)},opacity:0},{x:0,opacity:1,duration:0.7,ease:"power3.out"},0.6);
tl.to(["#lt-name","#lt-role"],{x:${Math.round(-40 * unit)},opacity:0,duration:0.45,ease:"power2.in"},${round(Math.max(0.6, duration - 0.7))});
tl.to("#lt-bar",{scaleY:0,duration:0.3,ease:"power2.in"},${round(Math.max(0.8, duration - 0.35))});`,
      };
    case "letterbox_bars": {
      const geometry = letterboxGeometry(width, height, ctx.aspect);
      return {
        css: `.bar{position:absolute;left:0;width:100%;height:${geometry.barHeightPx}px;background:#000}
#bar-top{top:0;transform-origin:50% 0}#bar-bottom{bottom:0;transform-origin:50% 100%}`,
        body: `<div id="bar-top" class="bar clip" data-start="0" data-duration="${duration}"></div>
<div id="bar-bottom" class="bar clip" data-start="0" data-duration="${duration}"></div>`,
        script: `tl.fromTo(["#bar-top","#bar-bottom"],{scaleY:0},{scaleY:1,duration:1.2,ease:"power2.inOut"},0);
tl.set({},{},${round(duration)});`,
      };
    }
    case "chapter_card":
      return {
        css: `#ch-kicker{position:absolute;top:42%;width:100%;text-align:center;font:500 ${px(28)} '${font}',serif;letter-spacing:.5em;color:${accent};text-transform:uppercase}
#ch-title{position:absolute;top:48%;width:100%;text-align:center;font:400 ${px(84)} '${font}',serif;color:${primary};letter-spacing:.08em}`,
        body: `<div id="ch-kicker" class="clip" data-start="0" data-duration="${duration}">${escapeHtml(t.kicker)}</div>
<div id="ch-title" class="clip" data-start="0" data-duration="${duration}">${escapeHtml(t.title)}</div>`,
        script: `tl.fromTo("#ch-kicker",{opacity:0},{opacity:1,duration:0.8,ease:"none"},0.2);
tl.fromTo("#ch-title",{opacity:0,y:${Math.round(24 * unit)}},{opacity:1,y:0,duration:1.2,ease:"power3.out"},0.5);
tl.to(["#ch-kicker","#ch-title"],{opacity:0,duration:0.7,ease:"power1.in"},${round(Math.max(0.6, duration - 0.7))});`,
      };
    case "kinetic_quote": {
      const words = t.quote.split(/\s+/).filter(Boolean).slice(0, 80);
      const step = Math.min(0.18, Math.max(0.04, (duration * 0.45) / Math.max(1, words.length)));
      return {
        css: `#quote{position:absolute;left:10%;right:10%;top:34%;text-align:center;font:500 ${px(64)} '${font}',serif;line-height:1.25;color:${primary}}
#quote .w{display:inline-block;margin:0 .14em}
#attrib{position:absolute;left:0;right:0;top:72%;text-align:center;font:400 ${px(30)} '${font}',sans-serif;letter-spacing:.24em;color:${accent};text-transform:uppercase}`,
        body: `<div id="quote" class="clip" data-start="0" data-duration="${duration}">${words.map(word => `<span class="w">${escapeHtml(word)}</span>`).join(" ")}</div>
<div id="attrib" class="clip" data-start="0" data-duration="${duration}">${escapeHtml(t.subtitle)}</div>`,
        script: `tl.fromTo("#quote .w",{opacity:0,y:${Math.round(40 * unit)}},{opacity:1,y:0,duration:0.6,ease:"power3.out",stagger:${round(step)}},0.2);
tl.fromTo("#attrib",{opacity:0},{opacity:1,duration:0.8},${round(0.4 + step * words.length)});
tl.to(["#quote","#attrib"],{opacity:0,duration:0.6,ease:"power1.in"},${round(Math.max(0.8, duration - 0.6))});`,
      };
    }
    case "end_credits_roll": {
      const lines = t.credits.map((line, index) => `<div class="cr" id="cr-${index}"><span class="cr-role">${escapeHtml(line.role)}</span><span class="cr-name">${escapeHtml(line.name)}</span></div>`).join("\n");
      const travel = height * 2 + t.credits.length * 72 * unit;
      return {
        css: `#roll{position:absolute;left:0;right:0;top:100%;text-align:center}
#roll-title{font:400 ${px(64)} '${font}',serif;color:${primary};letter-spacing:.2em;margin-bottom:${px(80)}}
.cr{display:flex;justify-content:center;gap:${px(36)};font:400 ${px(34)} '${font}',sans-serif;line-height:${px(72)}}
.cr-role{width:40%;text-align:right;color:${accent};text-transform:uppercase;letter-spacing:.14em;font-size:${px(26)}}
.cr-name{width:40%;text-align:left;color:${primary}}`,
        body: `<div id="roll" class="clip" data-start="0" data-duration="${duration}"><div id="roll-title">${escapeHtml(t.title)}</div>
${lines}
</div>`,
        script: `tl.fromTo("#roll",{y:0},{y:${-Math.round(travel)},duration:${round(duration)},ease:"none"},0);`,
      };
    }
    case "film_texture_overlay": {
      const frames = Math.max(2, Math.min(240, Math.round(ctx.fps * duration / 2)));
      const seeds = seededSequence(ctx.seed, frames, 1, 999);
      const weaveX = seededSequence(ctx.seed + 7, frames, -1.2, 1.2);
      const weaveY = seededSequence(ctx.seed + 13, frames, -0.8, 0.8);
      const step = round(duration / frames, 4);
      return {
        css: `#vignette{position:absolute;inset:0;background:radial-gradient(ellipse at center,rgba(0,0,0,0) 55%,rgba(0,0,0,.65) 100%)}
#grain{position:absolute;inset:-2%;width:104%;height:104%;opacity:${round(ctx.grain)};mix-blend-mode:overlay}`,
        body: `<div id="vignette" class="clip" data-start="0" data-duration="${duration}"></div>
<svg id="grain" class="clip" data-start="0" data-duration="${duration}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><filter id="noise"><feTurbulence id="turb" type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="1" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter><rect width="100%" height="100%" filter="url(#noise)"/></svg>`,
        script: `var seeds=${JSON.stringify(seeds)},wx=${JSON.stringify(weaveX)},wy=${JSON.stringify(weaveY)};
for(var i=0;i<seeds.length;i++){tl.set("#turb",{attr:{seed:seeds[i]}},${step}*i);tl.set("#grain",{x:wx[i],y:wy[i]},${step}*i);}
tl.set({},{},${round(duration)});`,
      };
    }
    case "light_leak_transition":
      return {
        css: `#leak{position:absolute;inset:-20%;background:radial-gradient(circle at 30% 50%,rgba(255,196,120,.95) 0%,rgba(255,120,60,.55) 30%,rgba(255,80,40,0) 62%);mix-blend-mode:screen}`,
        body: `<div id="leak" class="clip" data-start="0" data-duration="${duration}"></div>`,
        script: `tl.fromTo("#leak",{opacity:0,xPercent:-35,scale:0.9},{opacity:1,xPercent:0,scale:1.15,duration:${round(duration / 2)},ease:"power2.in"},0);
tl.to("#leak",{opacity:0,xPercent:35,scale:1.3,duration:${round(duration / 2)},ease:"power2.out"},${round(duration / 2)});`,
      };
    case "countdown_leader": {
      const count = Math.max(1, Math.min(10, Math.floor(duration)));
      const numbers = Array.from({ length: count }, (_, index) => count - index);
      return {
        css: `#ring{position:absolute;left:50%;top:50%;width:${px(620)};height:${px(620)};margin:${px(-310)} 0 0 ${px(-310)};border:${px(6)} solid ${primary};border-radius:50%}
#cross-h,#cross-v{position:absolute;background:${primary};opacity:.6}#cross-h{left:0;right:0;top:50%;height:${px(2)}}#cross-v{top:0;bottom:0;left:50%;width:${px(2)}}
#sweep{position:absolute;left:50%;top:50%;width:${px(310)};height:${px(4)};background:${accent};transform-origin:0 50%}
.num{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:700 ${px(380)} '${font}',sans-serif;color:${primary};opacity:0}`,
        body: `<div id="cross-h" class="clip" data-start="0" data-duration="${duration}"></div><div id="cross-v" class="clip" data-start="0" data-duration="${duration}"></div>
<div id="ring" class="clip" data-start="0" data-duration="${duration}"></div><div id="sweep" class="clip" data-start="0" data-duration="${duration}"></div>
${numbers.map((value, index) => `<div id="n${index}" class="num">${value}</div>`).join("")}`,
        script: `for(var i=0;i<${count};i++){tl.set("#n"+i,{opacity:1},i);tl.set("#n"+i,{opacity:0},i+0.96);tl.fromTo("#sweep",{rotation:-90},{rotation:270,duration:1,ease:"none"},i);}
tl.set({},{},${round(duration)});`,
      };
    }
  }
}

/** Author a self-contained, lint-clean HyperFrames composition for a cinematic preset. */
export function composeCinematicComposition(raw: Record<string, unknown>): ComposedComposition {
  const args = raw as unknown as ComposeArgs;
  if (!CINEMATIC_PRESET_IDS.includes(args.preset)) fail(`preset must be one of ${CINEMATIC_PRESET_IDS.join(", ")}`);
  const info = CINEMATIC_PRESETS.find(item => item.id === args.preset)!;
  if (args.resolution !== undefined && !(args.resolution in RESOLUTION_PRESETS)) fail(`resolution must be one of ${Object.keys(RESOLUTION_PRESETS).join(", ")}`);
  if ((args.width === undefined) !== (args.height === undefined)) fail("width and height must be supplied together");
  if (args.width !== undefined && args.resolution !== undefined) fail("use either resolution or width/height, not both");
  const base = RESOLUTION_PRESETS[args.resolution ?? "landscape"];
  const width = Math.round(finite(args.width, "width", 64, 8192, base.width) / 2) * 2;
  const height = Math.round(finite(args.height, "height", 64, 8192, base.height) / 2) * 2;
  const fps = finite(args.fps, "fps", 1, 120, 24);
  const duration = round(finite(args.duration_seconds, "duration_seconds", 0.5, 600, info.defaultDurationSeconds));
  const transparent = args.transparent ?? info.alphaByDefault;
  if (typeof transparent !== "boolean") fail("transparent must be a boolean");
  const compositionId = args.composition_id ?? args.preset.replace(/[^a-z0-9_]/g, "_");
  if (!COMPOSITION_ID.test(compositionId)) fail("composition_id must start with a lowercase letter and contain only a-z, 0-9, and _ (max 48)");
  const font = args.font_family ?? (args.preset === "lower_third" || args.preset === "countdown_leader" ? "Helvetica Neue" : "Cormorant Garamond");
  if (typeof font !== "string" || !FONT_FAMILY.test(font)) fail("font_family may contain only letters, digits, spaces, and hyphens (max 63)");
  const palette = args.palette ?? {};
  const bg = color(palette.background, "background", "#050505");
  const primary = color(palette.primary, "primary", "#f4efe6");
  const accent = color(palette.accent, "accent", "#d4a24c");
  const aspect = finite(args.letterbox_aspect, "letterbox_aspect", 1.34, 3, 2.39);
  const grain = finite(args.grain_intensity, "grain_intensity", 0, 1, 0.18);
  const seed = finite(args.seed, "seed", 1, 2147483647, 2383);
  const textIn = args.text ?? {};
  if (typeof textIn !== "object" || Array.isArray(textIn)) fail("text must be an object");
  const credits = textIn.credits ?? [];
  if (!Array.isArray(credits) || credits.length > MAX_CREDIT_LINES) fail(`text.credits must be an array of at most ${MAX_CREDIT_LINES} lines`);
  const t = {
    title: text(textIn.title, "title", args.preset === "end_credits_roll" ? "CREDITS" : "UNTITLED"),
    subtitle: text(textIn.subtitle, "subtitle", ""),
    kicker: text(textIn.kicker, "kicker", args.preset === "chapter_card" ? "Chapter One" : ""),
    name: text(textIn.name, "name", "Name Surname"),
    role: text(textIn.role, "role", "Title"),
    quote: text(textIn.quote, "quote", "Every frame tells a story."),
    credits: credits.map((line, index) => {
      if (!line || typeof line !== "object") fail(`text.credits[${index}] must be an object`);
      return { role: text(line.role, `credits[${index}].role`, ""), name: text(line.name, `credits[${index}].name`, "") };
    }),
  };
  if (args.preset === "end_credits_roll" && t.credits.length === 0) fail("end_credits_roll needs at least one text.credits line");
  const built = buildPreset(args.preset, { width, height, fps, duration, t, bg, primary, accent, font, aspect, grain, seed });
  const rootBackground = transparent ? "transparent" : bg;
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(info.title)}</title>
<style>
html,body{margin:0;padding:0;${transparent ? "" : `background:${bg};`}}
#root{position:relative;width:${width}px;height:${height}px;overflow:hidden;background:${rootBackground}}
.clip{will-change:transform,opacity}
${built.css}
</style>
</head>
<body>
<div id="root" data-composition-id="${compositionId}" data-start="0" data-duration="${duration}" data-fps="${fps}" data-width="${width}" data-height="${height}">
${built.body}
</div>
<script src="${GSAP_CDN_URL}"></script>
<script>
window.__timelines = window.__timelines || {};
var tl = gsap.timeline({ paused: true });
${built.script}
window.__timelines.${compositionId} = tl;
</script>
</body>
</html>
`;
  const format = transparent ? "mov" : "mp4";
  const lint = lintHyperframesComposition(html);
  return {
    preset: args.preset,
    compositionId,
    width,
    height,
    fps,
    durationSeconds: duration,
    transparent,
    html,
    sizeBytes: Buffer.byteLength(html, "utf8"),
    recommendedRender: {
      format,
      reason: transparent
        ? "MOV renders ProRes 4444 with alpha, which Premiere imports with transparency. Do not pass prores_profile; hq/422/lt/proxy drop alpha."
        : "MP4 (H.264) is opaque and imports directly into Premiere.",
      cliArgs: ["render", "--format", format, "--fps", String(fps), "--quality", "high"],
    },
    premierePlacement: {
      trackHint: transparent ? "Place on a video track above the picture it overlays." : "Place on V1 as a standalone shot or insert between shots.",
      ...(info.premiereBlendMode ? { blendMode: info.premiereBlendMode } : {}),
      notes: [
        "Import the rendered file with import_media, then place it with add_to_timeline.",
        ...(info.premiereBlendMode ? [`Apply set_blend_mode ${info.premiereBlendMode} to the overlay clip.`] : []),
        "Render at the sequence frame rate so overlay frames land on sequence frames.",
      ],
    },
    lint,
  };
}

export interface LintFinding {
  code: string;
  severity: "error" | "warning";
  message: string;
}

export interface LintReport {
  ok: boolean;
  errors: number;
  warnings: number;
  findings: LintFinding[];
  compositionId?: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

/**
 * Static subset of the HyperFrames lint contract. It is a fast local gate,
 * not a replacement for `npx hyperframes lint` / `check` in a browser.
 */
export function lintHyperframesComposition(html: string): LintReport {
  if (typeof html !== "string" || html.length === 0) fail("html must be a non-empty string");
  if (Buffer.byteLength(html, "utf8") > MAX_COMPOSITION_HTML_BYTES) fail(`html must be at most ${MAX_COMPOSITION_HTML_BYTES} bytes`);
  const findings: LintFinding[] = [];
  const add = (code: string, severity: "error" | "warning", message: string) => findings.push({ code, severity, message });
  const scripts = Array.from(html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi));
  const inlineJs = scripts.map(match => match[2]).join("\n");
  const rootTag = /<[a-z][a-z0-9-]*\b[^>]*\bdata-composition-id\s*=[^>]*>/i.exec(html)?.[0];
  let compositionId: string | undefined;
  let durationSeconds: number | undefined;
  let width: number | undefined;
  let height: number | undefined;
  if (!rootTag) {
    add("root_missing_composition_id", "error", "No element carries data-composition-id.");
  } else {
    compositionId = attribute(rootTag, "data-composition-id");
    const w = Number(attribute(rootTag, "data-width"));
    const h = Number(attribute(rootTag, "data-height"));
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) add("root_missing_dimensions", "error", "Root needs positive data-width and data-height.");
    else { width = w; height = h; }
    const d = Number(attribute(rootTag, "data-duration"));
    if (Number.isFinite(d) && d > 0) durationSeconds = d;
    else if (attribute(rootTag, "data-no-timeline") === undefined) add("root_composition_missing_duration_source", "error", "Root needs data-duration (seconds) or data-no-timeline.");
    if (attribute(rootTag, "data-start") === undefined) add("root_missing_start", "warning", "Root should declare data-start=\"0\".");
  }
  const usesGsap = /\bgsap\s*\./.test(inlineJs);
  const loadsGsap = scripts.some(match => /\bsrc\s*=\s*["'][^"']*gsap[^"']*["']/i.test(match[1]));
  if (usesGsap && !loadsGsap) add("missing_gsap_script", "error", "GSAP is used but no <script src> loads it before the animation script.");
  if (usesGsap || rootTag) {
    if (!/window\.__timelines\s*=/.test(inlineJs)) add("missing_timeline_registry", "error", "Initialize window.__timelines before registering the timeline.");
    const registered = Array.from(inlineJs.matchAll(/window\.__timelines(?:\.([A-Za-z_$][\w$]*)|\[\s*["']([^"']+)["']\s*\])\s*=(?!=)/g)).map(match => match[1] ?? match[2]);
    if (registered.length === 0 && attribute(rootTag ?? "", "data-no-timeline") === undefined) add("gsap_timeline_not_registered", "error", "No timeline is assigned to window.__timelines[<composition id>].");
    if (compositionId && registered.length > 0 && !registered.includes(compositionId)) add("timeline_id_mismatch", "error", `Registered timeline key(s) ${registered.join(", ")} do not match data-composition-id ${compositionId}.`);
  }
  if (/gsap\.timeline\s*\(/.test(inlineJs) && !/gsap\.timeline\s*\(\s*\{[^}]*paused\s*:\s*true/.test(inlineJs)) add("timeline_not_paused", "error", "Create the timeline with { paused: true }; the renderer seeks it.");
  if (/Math\.random\s*\(|Date\.now\s*\(|performance\.now\s*\(|new\s+Date\s*\(|gsap\.utils\.random|\brandom\s*\(/.test(inlineJs)) add("non_deterministic_code", "error", "Wall-clock or unseeded random code makes frames non-deterministic.");
  if (/requestAnimationFrame\s*\(/.test(inlineJs)) add("requestanimationframe_in_composition", "error", "requestAnimationFrame is not seekable; animate on the GSAP timeline.");
  if (/setTimeout\s*\(|setInterval\s*\(/.test(inlineJs)) add("system_timer_in_composition", "error", "setTimeout/setInterval are not seekable; animate on the GSAP timeline.");
  if (/repeat\s*:\s*-1/.test(inlineJs)) add("gsap_infinite_repeat", "error", "repeat: -1 makes the timeline infinite.");
  if (/\.play\s*\(\s*\)|\.currentTime\s*=(?!=)/.test(inlineJs)) add("imperative_media_control", "error", "Do not call play() or set currentTime; the renderer controls media.");
  if (/\bfetch\s*\(|XMLHttpRequest/.test(inlineJs)) add("network_request_in_composition", "warning", "Network requests during render are not deterministic; load assets up front.");
  for (const media of html.matchAll(/<(video|audio)\b[^>]*>/gi)) {
    const tag = media[0];
    const kind = media[1].toLowerCase();
    if (/\/\s*>$/.test(tag)) add("self_closing_media_tag", "error", `<${kind}> must not be self-closing.`);
    if (!attribute(tag, "id")) add("media_missing_id", "error", `<${kind}> needs an id.`);
    if (!attribute(tag, "src")) add("media_missing_src", "error", `<${kind}> needs a src.`);
    if (attribute(tag, "data-start") === undefined) add("media_missing_data_start", "error", `<${kind}> needs data-start.`);
    if (kind === "video" && !/\smuted(?:[\s=>]|$)/i.test(tag) && attribute(tag, "data-has-audio") !== "true") add("video_missing_muted", "error", "Timed <video> needs muted or data-has-audio=\"true\".");
  }
  for (const timed of html.matchAll(/<(?!video|audio)([a-z][a-z0-9-]*)\b[^>]*\bdata-start\s*=[^>]*>/gi)) {
    const tag = timed[0];
    if (attribute(tag, "data-composition-id") !== undefined) continue;
    if (!attribute(tag, "id")) add("timed_element_missing_id", "error", `Timed <${timed[1]}> needs an id.`);
    if (!/\bclass\s*=\s*["'][^"']*\bclip\b/i.test(tag)) add("timed_element_missing_clip_class", "warning", `Timed <${timed[1]}> should carry class="clip".`);
    const start = Number(attribute(tag, "data-start"));
    const length = Number(attribute(tag, "data-duration"));
    if (durationSeconds !== undefined && Number.isFinite(start) && Number.isFinite(length) && start + length > durationSeconds + 1e-6) add("clip_ends_past_root_duration", "warning", `<${timed[1]}> ends at ${round(start + length)}s, past root duration ${durationSeconds}s.`);
  }
  if (/[{;\s]transition\s*:/.test(Array.from(html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)).map(match => match[1]).join("\n"))) add("css_transition_used", "warning", "CSS transitions are not timeline-driven; animate with GSAP instead.");
  if (/z-index\s*:\s*-\d/.test(html)) add("negative_z_index", "warning", "Negative z-index can hide layers behind the root background.");
  const errors = findings.filter(item => item.severity === "error").length;
  return { ok: errors === 0, errors, warnings: findings.length - errors, findings, compositionId, durationSeconds, width, height };
}

export const PLATFORM_LOOKS = ["natural_filmic", "teal_orange", "warm_gold", "bleach_bypass", "cool_noir", "pastel_fade", "high_contrast_mono"] as const;
export type CinematicLook = (typeof PLATFORM_LOOKS)[number];

const LOOK_STARTING_POINTS: Record<CinematicLook, { exposure: number; contrast: number; highlights: number; shadows: number; whites: number; blacks: number; temperature: number; tint: number; saturation: number; note: string }> = {
  natural_filmic: { exposure: 0, contrast: 8, highlights: -18, shadows: 10, whites: -6, blacks: -4, temperature: 0, tint: 0, saturation: 95, note: "Gentle highlight roll-off and lifted shadows for a print-like curve." },
  teal_orange: { exposure: 0, contrast: 15, highlights: -20, shadows: 5, whites: 0, blacks: -10, temperature: 4, tint: -2, saturation: 108, note: "Push skin warm and shadows teal; finish with Lumetri Color Wheels (shadows toward cyan, highlights toward orange)." },
  warm_gold: { exposure: 0.1, contrast: 12, highlights: -15, shadows: 8, whites: 4, blacks: -6, temperature: 12, tint: 3, saturation: 104, note: "Golden-hour warmth suited to product and lifestyle work." },
  bleach_bypass: { exposure: -0.1, contrast: 35, highlights: -10, shadows: -10, whites: 8, blacks: -15, temperature: -2, tint: 0, saturation: 55, note: "Silver-retention look: high contrast, low saturation." },
  cool_noir: { exposure: -0.2, contrast: 25, highlights: -25, shadows: -12, whites: -4, blacks: -18, temperature: -14, tint: 2, saturation: 80, note: "Cool, dense blacks for thriller or night scenes." },
  pastel_fade: { exposure: 0.15, contrast: -15, highlights: -10, shadows: 20, whites: -10, blacks: 18, temperature: 3, tint: 4, saturation: 85, note: "Lifted blacks and soft contrast for a faded editorial look." },
  high_contrast_mono: { exposure: 0, contrast: 40, highlights: -10, shadows: -10, whites: 10, blacks: -20, temperature: 0, tint: 0, saturation: 0, note: "Black-and-white with deep contrast." },
};

export interface FinishingPlanArgs {
  frame?: { width?: number; height?: number };
  frame_rate?: number;
  target_aspect?: number;
  look?: CinematicLook;
  film_texture?: boolean;
  title?: string;
  include_countdown?: boolean;
}

/** Ordered, numeric cinematic finishing plan routed to registered tools. Pure computation. */
export function planCinematicFinishing(raw: Record<string, unknown>) {
  const args = raw as FinishingPlanArgs;
  const frame = args.frame ?? {};
  if (typeof frame !== "object" || Array.isArray(frame)) fail("frame must be an object");
  const width = Math.round(finite(frame.width, "frame.width", 64, 16384, 1920));
  const height = Math.round(finite(frame.height, "frame.height", 64, 16384, 1080));
  const fps = finite(args.frame_rate, "frame_rate", 1, 240, 24);
  const aspect = finite(args.target_aspect, "target_aspect", 1.34, 3, 2.39);
  const look = args.look ?? "natural_filmic";
  if (!PLATFORM_LOOKS.includes(look)) fail(`look must be one of ${PLATFORM_LOOKS.join(", ")}`);
  const frameAspect = width / height;
  const geometry = letterboxGeometry(width, height, aspect);
  const letterboxApplies = aspect > frameAspect + 0.005;
  const shutter = `1/${Math.round(fps * 2)}`;
  const grade = LOOK_STARTING_POINTS[look];
  const steps: Array<{ order: number; stage: string; tool: string; arguments: Record<string, unknown>; purpose: string }> = [];
  const push = (stage: string, tool: string, toolArgs: Record<string, unknown>, purpose: string) => steps.push({ order: steps.length + 1, stage, tool, arguments: toolArgs, purpose });
  push("protect", "create_sequence_checkpoint", {}, "Snapshot the sequence before finishing so every later step is reversible.");
  push("grade", "add_adjustment_layer", {}, "Create one grade layer above picture so the look applies uniformly and stays editable.");
  const { note, ...lumetri } = grade;
  push("grade", "color_correct", { node_id: "<adjustment layer node_id>", ...lumetri }, `${look} starting point. ${note} Starting values only; judge on calibrated scopes with read_video_scopes.`);
  if (letterboxApplies) {
    push("frame", "crop_clip", { node_id: "<adjustment layer node_id>", top: geometry.cropTopPercent, bottom: geometry.cropBottomPercent }, `Hard ${aspect}:1 matte (${geometry.barHeightPx}px bars). Alternatively render the letterbox_bars preset for animated bars.`);
  }
  if (args.film_texture !== false) {
    push("texture", "author_hyperframes_composition", { preset: "film_texture_overlay", width, height, fps, transparent: true }, "Seeded grain + vignette overlay rendered with alpha; then render_hyperframes_composition, import_media, add_to_timeline on the top track, set_blend_mode Overlay at 40-70% opacity.");
  }
  if (args.title !== undefined) {
    const title = text(args.title, "title", "");
    push("titles", "author_hyperframes_composition", { preset: "cinematic_title_card", width, height, fps, text: { title } }, "Opening title card, rendered with render_hyperframes_composition and placed after the cold open.");
  }
  if (args.include_countdown === true) push("titles", "author_hyperframes_composition", { preset: "countdown_leader", width, height, fps }, "Academy-style leader for openers or trailers.");
  push("review", "export_sequence_review_frames", {}, "Export review frames and compare against intent before delivery.");
  push("deliver", "validate_project_for_export", {}, "Check offline media and render readiness before export_and_verify.");
  return {
    frame: { width, height, aspect: round(frameAspect, 4) },
    frameRate: fps,
    letterbox: letterboxApplies ? geometry : { applies: false, reason: `Frame aspect ${round(frameAspect, 3)} is already at or wider than ${aspect}:1.` },
    look: { id: look, lumetriStartingPoint: lumetri, note },
    cameraGuidance: {
      shutter180Degree: shutter,
      motionBlur: `For natural motion blur at ${fps} fps use a ${shutter} s shutter (180-degree rule) when shooting; in post, avoid frame blending on speed changes unless the source lacks frames.`,
      slowMotion: `Clean slow motion needs source captured above ${fps} fps: conform 2x for 50% speed, 2.5x for 40%; otherwise prefer Optical Flow interpolation via set_time_interpolation.`,
    },
    editorialGuidance: [
      "Lead dialogue cuts with J/L cuts of roughly 6-12 frames so sound bridges picture changes.",
      "Cut on action and on music downbeats (detect_beats + plan_beat_montage) for rhythm.",
      "Hold wide establishing shots longer; shorten inserts as intensity rises.",
      "Keep titles inside 90% title-safe; check_caption_safe_zone verifies caption placement.",
    ],
    steps,
    verification: "Each routed mutating tool reports its own committed/verified state; this plan itself changes nothing.",
  };
}
