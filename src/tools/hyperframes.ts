import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  CINEMATIC_PRESETS,
  CINEMATIC_PRESET_IDS,
  LETTERBOX_ASPECTS,
  MAX_COMPOSITION_HTML_BYTES,
  MAX_CREDIT_LINES,
  MAX_TEXT_LENGTH,
  PLATFORM_LOOKS,
  RESOLUTION_PRESETS,
  composeCinematicComposition,
  lintHyperframesComposition,
  planCinematicFinishing,
} from "../ai/hyperframes-composer.js";

/**
 * HyperFrames (HeyGen, Apache-2.0) cinematic motion-graphics tools.
 *
 * Authoring and checking are pure computation. Writing a project, rendering
 * through the HyperFrames CLI, and probing the local toolchain touch the local
 * filesystem and spawn processes; none of these tools change Premiere. Rendered
 * files reach a sequence only through import_media and add_to_timeline.
 */

const execFileAsync = promisify(execFile);

export interface CommandRunResult { stdout: string; stderr: string }
export type CommandRunner = (file: string, args: readonly string[], options: { cwd?: string; timeoutMs: number }) => Promise<CommandRunResult>;

export interface HyperframesToolOptions {
  runCommand?: CommandRunner;
  /** Overrides CLI resolution (tests); returns the executable and leading arguments. */
  resolveCli?: (version: string) => { file: string; args: string[] } | null;
}

const defaultRunner: CommandRunner = async (file, args, options) => {
  const result = await execFileAsync(file, [...args], { cwd: options.cwd, timeout: options.timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
};

const CLI_VERSION = /^(?:latest|next|\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/;
const RENDER_FORMATS = ["mp4", "mov", "webm", "gif"] as const;
const QUALITY = ["draft", "standard", "high"] as const;
const ALPHA_PIX_FMT = /^(?:yuva|rgba|argb|bgra|abgr|gbrap|ya\d|pal8)/;

/** Locate npm's npx entry next to the running Node so no shell is ever involved. */
export function defaultResolveCli(version: string): { file: string; args: string[] } | null {
  const override = process.env.PREMIERE_MCP_HYPERFRAMES_CLI;
  if (override && override.trim()) {
    const path = resolve(override.trim());
    if (!existsSync(path)) return null;
    return /\.(?:c|m)?js$/i.test(path) ? { file: process.execPath, args: [path] } : { file: path, args: [] };
  }
  const nodeDir = dirname(process.execPath);
  const candidates = [
    join(nodeDir, "node_modules", "npm", "bin", "npx-cli.js"),
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
  ];
  const npx = candidates.find(path => existsSync(path));
  return npx ? { file: process.execPath, args: [npx, "--yes", `hyperframes@${version}`] } : null;
}

function ok<T>(data: T) { return { success: true as const, data }; }
function failure(error: unknown) { return { success: false as const, error: error instanceof Error ? error.message : String(error) }; }

function processFailure(error: unknown, operation: string, timeoutSeconds: number): string {
  const failed = error as { killed?: boolean; code?: unknown; stderr?: unknown; stdout?: unknown; message?: string };
  if (failed.killed) return `${operation} timed out after ${timeoutSeconds} seconds`;
  if (failed.code === "ENOENT") return `${operation} failed: executable not found`;
  const detail = String(failed.stderr || failed.stdout || failed.message || "unknown error").split(/\r?\n/).filter(Boolean).slice(-4).join(" ");
  return `${operation} failed: ${detail.slice(0, 600)}`;
}

function existingDirectory(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || !isAbsolute(value)) return null;
  const path = resolve(value);
  return existsSync(path) && statSync(path).isDirectory() ? path : null;
}

const textSchema = (description: string) => ({ type: "string", maxLength: MAX_TEXT_LENGTH, description });

const COMPOSE_PROPERTIES = {
  preset: { type: "string", enum: [...CINEMATIC_PRESET_IDS], description: "Cinematic preset to author; see list_cinematic_motion_presets." },
  composition_id: { type: "string", pattern: "^[a-z][a-z0-9_]{0,47}$", description: "Composition id and timeline key; defaults to the preset id." },
  resolution: { type: "string", enum: Object.keys(RESOLUTION_PRESETS), description: "Frame-size preset; defaults to landscape (1920x1080). Use width/height instead for a custom sequence size." },
  width: { type: "integer", minimum: 64, maximum: 8192, description: "Custom frame width in pixels (rounded to even); pass with height to match the Premiere sequence." },
  height: { type: "integer", minimum: 64, maximum: 8192, description: "Custom frame height in pixels (rounded to even)." },
  fps: { type: "number", minimum: 1, maximum: 120, description: "Composition frame rate; match the sequence (defaults to 24)." },
  duration_seconds: { type: "number", minimum: 0.5, maximum: 600, description: "Composition length in seconds; defaults per preset." },
  transparent: { type: "boolean", description: "Leave the background unpainted for an alpha render; defaults per preset (overlays are transparent)." },
  text: {
    type: "object",
    additionalProperties: false,
    description: "Text content. Every value is HTML-escaped; fields a preset does not use are ignored.",
    properties: {
      title: textSchema("Main title (title card, chapter card, credits heading)."),
      subtitle: textSchema("Subtitle or quote attribution."),
      kicker: textSchema("Small line above the title, such as 'A film by' or 'Chapter One'."),
      name: textSchema("Lower-third name."),
      role: textSchema("Lower-third role or location."),
      quote: textSchema("Quote text for kinetic_quote (first 80 words animate)."),
      credits: {
        type: "array",
        maxItems: MAX_CREDIT_LINES,
        description: "Credit lines for end_credits_roll.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: { role: textSchema("Credit role, such as Director."), name: textSchema("Credited name.") },
          required: ["name"],
        },
      },
    },
  },
  palette: {
    type: "object",
    additionalProperties: false,
    description: "Hex colors (#rgb, #rrggbb, or #rrggbbaa).",
    properties: {
      background: { type: "string", pattern: "^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$", description: "Opaque background color; ignored when transparent." },
      primary: { type: "string", pattern: "^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$", description: "Main text color." },
      accent: { type: "string", pattern: "^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$", description: "Accent rules, kickers, and roles." },
    },
  },
  font_family: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9 \\-]{0,62}$", description: "Installed font family name (letters, digits, spaces, hyphens). Render machines must have the font." },
  letterbox_aspect: { type: "number", minimum: 1.34, maximum: 3, description: `Target aspect for letterbox_bars, such as ${LETTERBOX_ASPECTS.join(", ")}; defaults to 2.39.` },
  grain_intensity: { type: "number", minimum: 0, maximum: 1, description: "Film grain opacity for film_texture_overlay; defaults to 0.18." },
  seed: { type: "integer", minimum: 1, maximum: 2147483647, description: "Deterministic grain seed; the same seed renders identical grain." },
} as const;

export function getHyperframesTools(options: HyperframesToolOptions = {}) {
  const run = options.runCommand ?? defaultRunner;
  const resolveCli = options.resolveCli ?? defaultResolveCli;

  return {
    list_cinematic_motion_presets: {
      description: "List built-in cinematic HyperFrames presets (title cards, lower thirds, letterbox, film texture, light leaks, credits, countdown), frame-size presets, grade looks, and related HyperFrames registry slugs. Local-only; never changes Premiere.",
      parameters: { type: "object" as const, additionalProperties: false, properties: {} },
      handler: async () => ok({
        presets: CINEMATIC_PRESETS,
        resolutions: RESOLUTION_PRESETS,
        letterboxAspects: LETTERBOX_ASPECTS,
        looks: PLATFORM_LOOKS,
        workflow: [
          "author_hyperframes_composition (preview HTML, then write with output_dir)",
          "check_hyperframes_composition",
          "render_hyperframes_composition (mov for alpha overlays, mp4 for opaque cards)",
          "import_media, then add_to_timeline; set_blend_mode for texture and light-leak overlays",
        ],
        registry: "More blocks: `npx hyperframes catalog --json` and `npx hyperframes add <slug>` inside a HyperFrames project.",
        source: "https://hyperframes.heygen.com",
      }),
    },

    author_hyperframes_composition: {
      description: "Author a deterministic, lint-checked HyperFrames HTML composition for a cinematic preset. Without output_dir returns the HTML only; with output_dir writes index.html into a new or empty folder (never overwrites). Never changes Premiere.",
      parameters: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          ...COMPOSE_PROPERTIES,
          output_dir: { type: "string", maxLength: 1024, description: "Absolute folder for the HyperFrames project; must not exist or be empty. Requires filesystem authority." },
          include_html: { type: "boolean", description: "Return the HTML text in the result; defaults to true without output_dir and false with it." },
        },
        required: ["preset"],
      },
      handler: async (args: Record<string, unknown>) => {
        try {
          const { output_dir: outputDir, include_html: includeHtml, ...composeArgs } = args ?? {};
          const composed = composeCinematicComposition(composeArgs);
          if (!composed.lint.ok) return failure(`Composition failed static checks: ${composed.lint.findings.map(item => item.code).join(", ")}`);
          const { html, ...summary } = composed;
          if (outputDir === undefined) return ok({ ...summary, ...(includeHtml === false ? {} : { html }), written: false });
          if (typeof outputDir !== "string" || !isAbsolute(outputDir)) return failure("output_dir must be an absolute path");
          const dir = resolve(outputDir);
          if (existsSync(dir)) {
            if (!statSync(dir).isDirectory()) return failure("output_dir exists and is not a folder");
            if (readdirSync(dir).length > 0) return failure("output_dir is not empty; author into a new folder so nothing is overwritten");
          } else {
            mkdirSync(dir, { recursive: true });
          }
          const indexPath = join(dir, "index.html");
          writeFileSync(indexPath, html, { encoding: "utf8", flag: "wx" });
          const readback = readFileSync(indexPath, "utf8");
          if (readback !== html) return failure("index.html readback did not match the authored composition");
          return ok({ ...summary, ...(includeHtml === true ? { html } : {}), written: true, verified: true, compositionDir: dir, indexPath });
        } catch (error) {
          return failure(error);
        }
      },
    },

    check_hyperframes_composition: {
      description: "Statically check HyperFrames HTML against the composition contract (root attributes, registered paused timeline, determinism, media rules). Pass html or an absolute file_path. Local-only; a fast gate, not a browser render check.",
      parameters: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          html: { type: "string", maxLength: MAX_COMPOSITION_HTML_BYTES, description: "Composition HTML text." },
          file_path: { type: "string", maxLength: 1024, description: "Absolute path to a composition .html file; requires filesystem authority." },
        },
      },
      handler: async (args: { html?: unknown; file_path?: unknown }) => {
        try {
          if ((args?.html === undefined) === (args?.file_path === undefined)) return failure("Provide exactly one of html or file_path");
          let html: string;
          if (args.file_path !== undefined) {
            if (typeof args.file_path !== "string" || !isAbsolute(args.file_path) || extname(args.file_path).toLowerCase() !== ".html") return failure("file_path must be an absolute .html path");
            const path = resolve(args.file_path);
            if (!existsSync(path) || !statSync(path).isFile()) return failure("file_path must identify an existing file");
            if (statSync(path).size > MAX_COMPOSITION_HTML_BYTES) return failure(`file_path exceeds ${MAX_COMPOSITION_HTML_BYTES} bytes`);
            html = readFileSync(path, "utf8");
          } else {
            if (typeof args.html !== "string") return failure("html must be a string");
            html = args.html;
          }
          return ok(lintHyperframesComposition(html));
        } catch (error) {
          return failure(error);
        }
      },
    },

    render_hyperframes_composition: {
      description: "Render a HyperFrames project folder to a new video file with the HyperFrames CLI (npx, Node 22+, FFmpeg, Chrome), then verify the file with ffprobe. Never overwrites and never changes Premiere; import the result with import_media.",
      parameters: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          composition_dir: { type: "string", maxLength: 1024, description: "Absolute HyperFrames project folder containing index.html." },
          output_path: { type: "string", maxLength: 1024, description: "Absolute new output file; extension must match format." },
          format: { type: "string", enum: [...RENDER_FORMATS], description: "mp4 (opaque H.264, default), mov (ProRes 4444 with alpha), webm (VP9 alpha), or gif." },
          fps: { type: "number", minimum: 1, maximum: 120, description: "Render frame rate; defaults to the composition data-fps." },
          quality: { type: "string", enum: [...QUALITY], description: "Encoder quality tier; defaults to high." },
          workers: { type: "integer", minimum: 1, maximum: 24, description: "Parallel render workers." },
          expect_alpha: { type: "boolean", description: "Fail verification unless the output has an alpha channel; defaults to true for mov/webm when the composition background is transparent." },
          cli_version: { type: "string", maxLength: 40, pattern: "^(?:latest|next|\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.]+)?)$", description: "HyperFrames npm version to run; defaults to latest. Pin for reproducible renders." },
          timeout_seconds: { type: "integer", minimum: 30, maximum: 3600, description: "Render timeout; defaults to 900." },
        },
        required: ["composition_dir", "output_path"],
      },
      handler: async (args: Record<string, unknown>) => {
        const timeoutSeconds = typeof args?.timeout_seconds === "number" ? args.timeout_seconds : 900;
        try {
          const dir = existingDirectory(args.composition_dir);
          if (!dir) return failure("composition_dir must be an absolute path to an existing folder");
          const indexPath = join(dir, "index.html");
          if (!existsSync(indexPath)) return failure("composition_dir must contain index.html");
          const format = (args.format ?? "mp4") as string;
          if (!RENDER_FORMATS.includes(format as (typeof RENDER_FORMATS)[number])) return failure(`format must be one of ${RENDER_FORMATS.join(", ")}`);
          if (typeof args.output_path !== "string" || !isAbsolute(args.output_path)) return failure("output_path must be an absolute path");
          const outputPath = resolve(args.output_path);
          if (extname(outputPath).toLowerCase() !== `.${format}`) return failure(`output_path must end in .${format}`);
          if (existsSync(outputPath)) return failure("output_path already exists; renders never overwrite files");
          if (!existsSync(dirname(outputPath))) return failure("output_path folder must already exist");
          const quality = (args.quality ?? "high") as string;
          if (!QUALITY.includes(quality as (typeof QUALITY)[number])) return failure(`quality must be one of ${QUALITY.join(", ")}`);
          const version = (args.cli_version ?? "latest") as string;
          if (typeof version !== "string" || !CLI_VERSION.test(version)) return failure("cli_version must be latest, next, or an exact semver");
          if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 3600) return failure("timeout_seconds must be an integer from 30 through 3600");

          const html = readFileSync(indexPath, "utf8");
          const lint = lintHyperframesComposition(html);
          if (!lint.ok) return failure(`index.html failed static checks: ${lint.findings.filter(item => item.severity === "error").map(item => item.code).join(", ")}`);
          const transparentSource = /#root\{[^}]*background:transparent/.test(html.replace(/\s+/g, ""));
          const expectAlpha = typeof args.expect_alpha === "boolean" ? args.expect_alpha : (format === "mov" || format === "webm") && transparentSource;
          if (expectAlpha && (format === "mp4" || format === "gif")) return failure(`${format} cannot carry alpha; use mov or webm`);

          const cli = resolveCli(version);
          if (!cli) return failure("HyperFrames CLI unavailable: npx was not found next to Node; set PREMIERE_MCP_HYPERFRAMES_CLI to the hyperframes CLI path");
          const renderArgs = [...cli.args, "render", "--output", outputPath, "--format", format, "--quality", quality];
          if (args.fps !== undefined) {
            if (typeof args.fps !== "number" || !Number.isFinite(args.fps) || args.fps < 1 || args.fps > 120) return failure("fps must be from 1 through 120");
            renderArgs.push("--fps", String(args.fps));
          }
          if (args.workers !== undefined) {
            if (!Number.isInteger(args.workers) || (args.workers as number) < 1 || (args.workers as number) > 24) return failure("workers must be an integer from 1 through 24");
            renderArgs.push("--workers", String(args.workers));
          }
          const started = Date.now();
          let cliOutput: CommandRunResult;
          try {
            cliOutput = await run(cli.file, renderArgs, { cwd: dir, timeoutMs: timeoutSeconds * 1000 });
          } catch (error) {
            return failure(processFailure(error, "HyperFrames render", timeoutSeconds));
          }
          if (!existsSync(outputPath) || !statSync(outputPath).isFile() || statSync(outputPath).size === 0) {
            return failure(`HyperFrames render finished without creating ${outputPath}: ${(cliOutput.stderr || cliOutput.stdout).split(/\r?\n/).filter(Boolean).slice(-3).join(" ").slice(0, 600)}`);
          }
          const sizeBytes = statSync(outputPath).size;
          const renderSeconds = Math.round((Date.now() - started) / 100) / 10;
          let probe: { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
          try {
            const probed = await run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", outputPath], { timeoutMs: 60_000 });
            probe = JSON.parse(probed.stdout);
          } catch (error) {
            return ok({ status: "committed_unverified", outputPath, sizeBytes, renderSeconds, format, reason: processFailure(error, "ffprobe verification", 60), nextSteps: ["inspect_media_streams", "import_media"] });
          }
          const video = probe.streams?.find(stream => stream.codec_type === "video");
          if (!video) return failure(`Rendered file has no video stream: ${outputPath}`);
          const pixFmt = String(video.pix_fmt ?? "");
          const tags = (video.tags ?? {}) as Record<string, unknown>;
          const hasAlpha = ALPHA_PIX_FMT.test(pixFmt) || String(tags.alpha_mode ?? tags.ALPHA_MODE ?? "") === "1";
          const width = Number(video.width), height = Number(video.height);
          const durationSeconds = Number(probe.format?.duration ?? video.duration);
          const mismatches: string[] = [];
          if (lint.width && lint.height && (width !== lint.width || height !== lint.height)) mismatches.push(`size ${width}x${height} differs from composition ${lint.width}x${lint.height}`);
          if (lint.durationSeconds && Number.isFinite(durationSeconds) && Math.abs(durationSeconds - lint.durationSeconds) > 0.25) mismatches.push(`duration ${durationSeconds}s differs from composition ${lint.durationSeconds}s`);
          if (expectAlpha && !hasAlpha) mismatches.push(`expected alpha but pixel format is ${pixFmt || "unknown"}`);
          const evidence = { outputPath, sizeBytes, renderSeconds, format, codec: video.codec_name, pixelFormat: pixFmt, hasAlpha, width, height, durationSeconds, frameRate: video.r_frame_rate };
          if (mismatches.length > 0) return { success: false as const, error: `Render verification failed: ${mismatches.join("; ")}`, data: { status: "failed_verification", ...evidence } };
          return ok({ status: "verified", ...evidence, nextSteps: ["import_media", "add_to_timeline", ...(hasAlpha ? ["set_blend_mode (for texture or light-leak overlays)"] : [])] });
        } catch (error) {
          return failure(error);
        }
      },
    },

    inspect_hyperframes_environment: {
      description: "Report whether this machine can render HyperFrames: Node version on PATH (22+ required), ffmpeg/ffprobe availability, and the npx location. Optionally runs `hyperframes doctor` (downloads the CLI). Never changes Premiere.",
      parameters: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          run_doctor: { type: "boolean", description: "Also run `npx hyperframes doctor` (may download the package from npm); defaults to false." },
          cli_version: { type: "string", maxLength: 40, pattern: "^(?:latest|next|\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.]+)?)$", description: "HyperFrames npm version for doctor; defaults to latest." },
        },
      },
      handler: async (args: { run_doctor?: unknown; cli_version?: unknown }) => {
        const probe = async (file: string, probeArgs: string[]) => {
          try {
            const result = await run(file, probeArgs, { timeoutMs: 30_000 });
            return { available: true, version: (result.stdout || result.stderr).split(/\r?\n/)[0].trim().slice(0, 200) };
          } catch (error) {
            return { available: false, error: processFailure(error, file, 30) };
          }
        };
        const [node, ffmpeg, ffprobe] = await Promise.all([probe("node", ["--version"]), probe("ffmpeg", ["-version"]), probe("ffprobe", ["-version"])]);
        const nodeMajor = node.available ? Number(/v(\d+)/.exec(node.version ?? "")?.[1]) : NaN;
        const version = (args?.cli_version ?? "latest") as string;
        if (typeof version !== "string" || !CLI_VERSION.test(version)) return failure("cli_version must be latest, next, or an exact semver");
        const cli = resolveCli(version);
        let doctor: unknown;
        if (args?.run_doctor === true && cli) {
          try {
            const result = await run(cli.file, [...cli.args, "doctor"], { timeoutMs: 300_000 });
            doctor = { ran: true, output: (result.stdout + result.stderr).split(/\r?\n/).filter(Boolean).slice(0, 40) };
          } catch (error) {
            doctor = { ran: true, error: processFailure(error, "hyperframes doctor", 300) };
          }
        }
        const blockers = [
          ...(Number.isFinite(nodeMajor) && nodeMajor >= 22 ? [] : ["Node.js 22+ must be on PATH for the HyperFrames CLI"]),
          ...(ffmpeg.available ? [] : ["ffmpeg not found on PATH"]),
          ...(ffprobe.available ? [] : ["ffprobe not found on PATH"]),
          ...(cli ? [] : ["npx not found next to Node; set PREMIERE_MCP_HYPERFRAMES_CLI"]),
        ];
        return ok({
          ready: blockers.length === 0,
          blockers,
          node: { ...node, major: Number.isFinite(nodeMajor) ? nodeMajor : null },
          ffmpeg,
          ffprobe,
          cli: cli ? { resolved: true, file: cli.file, leadingArgs: cli.args } : { resolved: false },
          chrome: "Rendering needs Chrome; run_doctor reports it, and `npx hyperframes browser ensure` installs one.",
          ...(doctor ? { doctor } : {}),
        });
      },
    },

    plan_cinematic_finishing: {
      description: "Plan a professional cinematic finish: letterbox matte geometry, a Lumetri starting look, 180-degree shutter and slow-motion guidance, and ordered routes to registered grade, crop, HyperFrames texture/title, review, and delivery tools. Local-only and deterministic; never changes Premiere.",
      parameters: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          frame: {
            type: "object",
            additionalProperties: false,
            description: "Sequence frame size; defaults to 1920x1080.",
            properties: {
              width: { type: "integer", minimum: 64, maximum: 16384, description: "Frame width in pixels." },
              height: { type: "integer", minimum: 64, maximum: 16384, description: "Frame height in pixels." },
            },
          },
          frame_rate: { type: "number", minimum: 1, maximum: 240, description: "Sequence frame rate; defaults to 24." },
          target_aspect: { type: "number", minimum: 1.34, maximum: 3, description: "Cinematic aspect for the matte, such as 2.39, 2.0, or 1.85; defaults to 2.39." },
          look: { type: "string", enum: [...PLATFORM_LOOKS], description: "Grade starting point; defaults to natural_filmic." },
          film_texture: { type: "boolean", description: "Include the HyperFrames grain/vignette overlay step; defaults to true." },
          title: { type: "string", maxLength: MAX_TEXT_LENGTH, description: "Optional opening title; adds a cinematic_title_card step." },
          include_countdown: { type: "boolean", description: "Add a countdown leader step." },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        try {
          return ok(planCinematicFinishing(args ?? {}));
        } catch (error) {
          return failure(error);
        }
      },
    },
  };
}
