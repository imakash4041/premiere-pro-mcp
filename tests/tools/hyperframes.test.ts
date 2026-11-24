import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getHyperframesTools, type CommandRunner } from "../../src/tools/hyperframes.js";
import {
  CINEMATIC_PRESET_IDS,
  composeCinematicComposition,
  escapeHtml,
  letterboxGeometry,
  lintHyperframesComposition,
  planCinematicFinishing,
} from "../../src/ai/hyperframes-composer.js";
import { capabilitiesForToolInvocation } from "../../src/security/capabilities.js";

const dirs: string[] = [];
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "hf-test-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("HyperFrames composer", () => {
  it("authors every preset as lint-clean deterministic HTML", () => {
    for (const preset of CINEMATIC_PRESET_IDS) {
      const result = composeCinematicComposition({ preset, text: { credits: [{ role: "Director", name: "A. Person" }] } });
      expect(result.lint, preset).toMatchObject({ ok: true, errors: 0 });
      expect(result.html).toContain(`data-composition-id="${result.compositionId}"`);
      expect(result.html).toContain(`window.__timelines.${result.compositionId} = tl;`);
      expect(result.html).not.toMatch(/Math\.random|Date\.now|requestAnimationFrame|repeat:\s*-1/);
      expect(composeCinematicComposition({ preset, text: { credits: [{ name: "x" }] } }).html).toBe(composeCinematicComposition({ preset, text: { credits: [{ name: "x" }] } }).html);
    }
  });

  it("escapes every user string and refuses unsafe CSS values", () => {
    const result = composeCinematicComposition({ preset: "lower_third", text: { name: "<script>alert(1)</script>", role: "\"x\" & 'y'" } });
    expect(result.html).not.toContain("<script>alert");
    expect(result.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(escapeHtml("a&b\"'<>")).toBe("a&amp;b&quot;&#39;&lt;&gt;");
    expect(() => composeCinematicComposition({ preset: "lower_third", palette: { accent: "red;}body{x" } })).toThrow(/hex color/);
    expect(() => composeCinematicComposition({ preset: "lower_third", font_family: "Arial';}" })).toThrow(/font_family/);
    expect(() => composeCinematicComposition({ preset: "lower_third", composition_id: "Bad-Id" })).toThrow(/composition_id/);
    expect(() => composeCinematicComposition({ preset: "nope" })).toThrow(/preset/);
    expect(() => composeCinematicComposition({ preset: "end_credits_roll" })).toThrow(/credits/);
    expect(() => composeCinematicComposition({ preset: "title", width: 100 })).toThrow();
  });

  it("uses transparent roots and MOV for overlays, opaque MP4 for cards", () => {
    const overlay = composeCinematicComposition({ preset: "film_texture_overlay", width: 1080, height: 1920, fps: 30 });
    expect(overlay).toMatchObject({ transparent: true, width: 1080, height: 1920, recommendedRender: { format: "mov" }, premierePlacement: { blendMode: "Overlay" } });
    expect(overlay.html).toContain("background:transparent");
    const card = composeCinematicComposition({ preset: "cinematic_title_card", resolution: "landscape-4k" });
    expect(card).toMatchObject({ transparent: false, width: 3840, height: 2160, recommendedRender: { format: "mp4" } });
  });

  it("computes even letterbox bars and crop percentages", () => {
    expect(letterboxGeometry(1920, 1080, 2.39)).toEqual({ aspect: 2.39, activeHeightPx: 804, barHeightPx: 138, cropTopPercent: 12.7778, cropBottomPercent: 12.7778 });
  });

  it("flags contract violations", () => {
    const report = lintHyperframesComposition(`<div id="root" data-composition-id="main" data-start="0" data-width="1920" data-height="1080">
<video src="a.mp4" data-start="0"/><div data-start="0" data-duration="9"></div></div>
<script>var tl = gsap.timeline(); tl.to("#a",{x:Math.random(),repeat:-1}); window.__timelines = {}; window.__timelines.other = tl; requestAnimationFrame(f);</script>`);
    const codes = report.findings.map(item => item.code);
    expect(report.ok).toBe(false);
    for (const code of ["root_composition_missing_duration_source", "missing_gsap_script", "timeline_id_mismatch", "timeline_not_paused", "non_deterministic_code", "requestanimationframe_in_composition", "gsap_infinite_repeat", "self_closing_media_tag", "media_missing_id", "video_missing_muted", "timed_element_missing_id", "timed_element_missing_clip_class"]) expect(codes, code).toContain(code);
    expect(lintHyperframesComposition("<p>x</p>").findings.map(item => item.code)).toContain("root_missing_composition_id");
  });

  it("plans a cinematic finish routed to registered tools", () => {
    const plan = planCinematicFinishing({ frame: { width: 1920, height: 1080 }, frame_rate: 24, look: "teal_orange", title: "NIGHTFALL", include_countdown: true });
    expect(plan.letterbox).toMatchObject({ barHeightPx: 138 });
    expect(plan.cameraGuidance.shutter180Degree).toBe("1/48");
    expect(plan.steps.map(step => step.tool)).toEqual(["create_sequence_checkpoint", "add_adjustment_layer", "color_correct", "crop_clip", "author_hyperframes_composition", "author_hyperframes_composition", "author_hyperframes_composition", "export_sequence_review_frames", "validate_project_for_export"]);
    expect(planCinematicFinishing({ frame: { width: 2560, height: 1080 }, target_aspect: 2.35, film_texture: false }).letterbox).toMatchObject({ applies: false });
    expect(() => planCinematicFinishing({ look: "neon" })).toThrow(/look/);
  });
});

describe("HyperFrames tools", () => {
  it("resolves argument-dependent authority", () => {
    expect(capabilitiesForToolInvocation("author_hyperframes_composition", {})).toEqual(["inspect"]);
    expect(capabilitiesForToolInvocation("author_hyperframes_composition", { output_dir: "/x" })).toEqual(["inspect", "filesystem"]);
    expect(capabilitiesForToolInvocation("check_hyperframes_composition", { file_path: "/x.html" })).toEqual(["inspect", "filesystem"]);
    expect(capabilitiesForToolInvocation("render_hyperframes_composition", {})).toEqual(["filesystem"]);
    expect(capabilitiesForToolInvocation("plan_cinematic_finishing", {})).toEqual(["inspect"]);
  });

  it("lists presets and returns HTML without writing", async () => {
    const tools = getHyperframesTools();
    const listed = await tools.list_cinematic_motion_presets.handler();
    expect(listed.data.presets).toHaveLength(CINEMATIC_PRESET_IDS.length);
    const preview = await tools.author_hyperframes_composition.handler({ preset: "chapter_card", text: { title: "The Return" } });
    expect(preview).toMatchObject({ success: true, data: { written: false } });
    expect((preview as { data: { html: string } }).data.html).toContain("The Return");
    expect(await tools.author_hyperframes_composition.handler({ preset: "bad" })).toMatchObject({ success: false });
  });

  it("writes into a new folder with readback and refuses to overwrite", async () => {
    const tools = getHyperframesTools();
    const dir = join(tempDir(), "title");
    const written = await tools.author_hyperframes_composition.handler({ preset: "cinematic_title_card", output_dir: dir });
    expect(written).toMatchObject({ success: true, data: { written: true, verified: true } });
    expect(readFileSync(join(dir, "index.html"), "utf8")).toContain("data-composition-id");
    expect(await tools.author_hyperframes_composition.handler({ preset: "cinematic_title_card", output_dir: dir })).toMatchObject({ success: false, error: expect.stringMatching(/not empty/) });
    expect(await tools.author_hyperframes_composition.handler({ preset: "cinematic_title_card", output_dir: "relative/dir" })).toMatchObject({ success: false });
  });

  it("checks html or files and requires exactly one source", async () => {
    const tools = getHyperframesTools();
    const html = composeCinematicComposition({ preset: "lower_third" }).html;
    expect(await tools.check_hyperframes_composition.handler({ html })).toMatchObject({ success: true, data: { ok: true } });
    const file = join(tempDir(), "index.html");
    writeFileSync(file, html);
    expect(await tools.check_hyperframes_composition.handler({ file_path: file })).toMatchObject({ success: true, data: { ok: true } });
    expect(await tools.check_hyperframes_composition.handler({})).toMatchObject({ success: false });
    expect(await tools.check_hyperframes_composition.handler({ html, file_path: file })).toMatchObject({ success: false });
  });

  function renderFixture(preset = "film_texture_overlay") {
    const root = tempDir();
    const project = join(root, "project");
    mkdirSync(project);
    const composed = composeCinematicComposition({ preset: preset as never, width: 1920, height: 1080, duration_seconds: 4 });
    writeFileSync(join(project, "index.html"), composed.html);
    return { root, project };
  }

  it("renders through the CLI without a shell and verifies alpha with ffprobe", async () => {
    const { root, project } = renderFixture();
    const output = join(root, "grain.mov");
    const runCommand = vi.fn<CommandRunner>(async (file, args) => {
      if (file === "ffprobe") return { stdout: JSON.stringify({ streams: [{ codec_type: "video", codec_name: "prores", pix_fmt: "yuva444p12le", width: 1920, height: 1080, r_frame_rate: "24/1" }], format: { duration: "4.0" } }), stderr: "" };
      writeFileSync(args[args.indexOf("--output") + 1], "data");
      return { stdout: "done", stderr: "" };
    });
    const tools = getHyperframesTools({ runCommand, resolveCli: () => ({ file: "node", args: ["npx-cli.js", "--yes", "hyperframes@latest"] }) });
    const result = await tools.render_hyperframes_composition.handler({ composition_dir: project, output_path: output, format: "mov", fps: 24 });
    expect(result).toMatchObject({ success: true, data: { status: "verified", hasAlpha: true, width: 1920, height: 1080 } });
    expect(runCommand.mock.calls[0][1]).toEqual(["npx-cli.js", "--yes", "hyperframes@latest", "render", "--output", output, "--format", "mov", "--quality", "high", "--fps", "24"]);
    expect(runCommand.mock.calls[0][2]).toMatchObject({ cwd: project });
    expect(await tools.render_hyperframes_composition.handler({ composition_dir: project, output_path: output, format: "mov" })).toMatchObject({ success: false, error: expect.stringMatching(/already exists/) });
  });

  it("fails verification when alpha or size is wrong and reports unverified when ffprobe is missing", async () => {
    const { root, project } = renderFixture();
    const makeRunner = (probe: () => Promise<{ stdout: string; stderr: string }>): CommandRunner => async (file, args) => {
      if (file === "ffprobe") return probe();
      writeFileSync(args[args.indexOf("--output") + 1], "data");
      return { stdout: "", stderr: "" };
    };
    const cli = () => ({ file: "hf", args: [] });
    const opaque = getHyperframesTools({ resolveCli: cli, runCommand: makeRunner(async () => ({ stdout: JSON.stringify({ streams: [{ codec_type: "video", pix_fmt: "yuv422p10le", width: 1280, height: 720 }], format: { duration: "4" } }), stderr: "" })) });
    const bad = await opaque.render_hyperframes_composition.handler({ composition_dir: project, output_path: join(root, "a.mov"), format: "mov" });
    expect(bad).toMatchObject({ success: false, error: expect.stringMatching(/expected alpha.*|size/) });
    const missing = getHyperframesTools({ resolveCli: cli, runCommand: makeRunner(async () => { throw Object.assign(new Error("spawn ffprobe ENOENT"), { code: "ENOENT" }); }) });
    expect(await missing.render_hyperframes_composition.handler({ composition_dir: project, output_path: join(root, "b.mov"), format: "mov" })).toMatchObject({ success: true, data: { status: "committed_unverified" } });
  });

  it("validates render inputs before spawning", async () => {
    const { root, project } = renderFixture("cinematic_title_card");
    const runCommand = vi.fn<CommandRunner>();
    const tools = getHyperframesTools({ runCommand, resolveCli: () => ({ file: "hf", args: [] }) });
    const cases: Array<Record<string, unknown>> = [
      { composition_dir: "relative", output_path: join(root, "x.mp4") },
      { composition_dir: root, output_path: join(root, "x.mp4") },
      { composition_dir: project, output_path: join(root, "x.mov"), format: "mp4" },
      { composition_dir: project, output_path: join(root, "x.mkv"), format: "mkv" },
      { composition_dir: project, output_path: join(root, "missing", "x.mp4") },
      { composition_dir: project, output_path: join(root, "x.mp4"), cli_version: "1.0; rm -rf /" },
      { composition_dir: project, output_path: join(root, "x.mp4"), expect_alpha: true },
      { composition_dir: project, output_path: join(root, "x.mp4"), workers: 99 },
    ];
    for (const args of cases) expect(await tools.render_hyperframes_composition.handler(args), JSON.stringify(args)).toMatchObject({ success: false });
    expect(runCommand).not.toHaveBeenCalled();
    writeFileSync(join(project, "index.html"), "<p>broken</p>");
    expect(await tools.render_hyperframes_composition.handler({ composition_dir: project, output_path: join(root, "y.mp4") })).toMatchObject({ success: false, error: expect.stringMatching(/static checks/) });
    const noCli = getHyperframesTools({ runCommand, resolveCli: () => null });
    const fresh = renderFixture("cinematic_title_card");
    expect(await noCli.render_hyperframes_composition.handler({ composition_dir: fresh.project, output_path: join(fresh.root, "z.mp4") })).toMatchObject({ success: false, error: expect.stringMatching(/CLI unavailable/) });
    const failing = getHyperframesTools({ resolveCli: () => ({ file: "hf", args: [] }), runCommand: async () => { throw Object.assign(new Error("x"), { stderr: "chrome_not_found" }); } });
    expect(await failing.render_hyperframes_composition.handler({ composition_dir: fresh.project, output_path: join(fresh.root, "z.mp4") })).toMatchObject({ success: false, error: expect.stringMatching(/chrome_not_found/) });
    expect(existsSync(join(fresh.root, "z.mp4"))).toBe(false);
  });

  it("reports environment readiness and blockers", async () => {
    const runCommand = vi.fn<CommandRunner>(async (file) => {
      if (file === "node") return { stdout: "v24.1.0\n", stderr: "" };
      if (file === "ffmpeg") return { stdout: "ffmpeg version 7.1\n", stderr: "" };
      if (file === "hf") return { stdout: "all good\n", stderr: "" };
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const tools = getHyperframesTools({ runCommand, resolveCli: () => ({ file: "hf", args: [] }) });
    const report = await tools.inspect_hyperframes_environment.handler({ run_doctor: true });
    expect(report).toMatchObject({ success: true, data: { ready: false, blockers: ["ffprobe not found on PATH"], node: { major: 24 }, doctor: { ran: true } } });
    expect(await tools.inspect_hyperframes_environment.handler({ cli_version: "$(x)" })).toMatchObject({ success: false });
  });
});
