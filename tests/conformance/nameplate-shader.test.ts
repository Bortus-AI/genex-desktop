/**
 * The Pro nameplate's pieces, compiled and drawn by Dawn (vgpu's Node adapter): every piece's
 * module compiles cleanly and draws a sidebar-sized plate that is opaque, holds real art for two
 * accounts' recipes and moves with its clock. Skipped where this machine has no WebGPU adapter.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { PLATE_UNIFORM_BYTES, plateShader, plateUniforms } from "../../src/renderer/nameplate/plate-shaders.ts";
import { PLATE_SCENES, type PlateRecipe, PlateScene, plateRecipe } from "../../src/shared/plate-recipe.ts";

const WIDTH = 240;
const HEIGHT = 44;
const FORMAT: GPUTextureFormat = "rgba8unorm";
/** A readback row, padded to WebGPU's 256-byte copy alignment. */
const BYTES_PER_ROW = Math.ceil((WIDTH * 4) / 256) * 256;
/** A plate with this many distinct colours or fewer is a flat fill or a broken draw, not a piece. */
const MIN_COLOURS = 12;
/** WebGPU's usage and map flags, spelled out: the DOM types name their type but not the constants. */
const USAGE = {
  textureCopySrc: 0x01,
  renderAttachment: 0x10,
  mapRead: 0x01,
  copyDst: 0x08,
  uniform: 0x40,
  read: 0x01,
} as const;

/** Two accounts' plates at the pixel ratios a sidebar meets, each at its own moment. */
const DRAWS = [
  { id: "fx-rab-neba", variant: 1, dpr: 2, seconds: 3 },
  { id: "fx-kenji-mori", variant: 4, dpr: 1, seconds: 7 },
] as const;

let release: (() => void) | null = null;
let device: GPUDevice | null = null;

/** A recipe on piece `index`, everything else as the account's roll has it. */
const onPiece = (index: number, id: string, variant: number): PlateRecipe => ({
  ...plateRecipe(id, variant),
  scene: PLATE_SCENES[index] ?? PlateScene.NeonRain,
  sceneIndex: index,
});

/** The piece's module, with the compiler's errors as `line:pos message`. */
async function compile(gpu: GPUDevice, index: number): Promise<{ module: GPUShaderModule; errors: string[] }> {
  const module = gpu.createShaderModule({ code: plateShader(index) });
  const info = await module.getCompilationInfo();
  const errors = info.messages
    .filter((message) => message.type === "error")
    .map((message) => `${message.lineNum}:${message.linePos} ${message.message}`);
  return { module, errors };
}

/** Draw one plate at WIDTH by HEIGHT and read it back as RGBA bytes, row by row. */
async function render(
  gpu: GPUDevice,
  pipeline: GPURenderPipeline,
  recipe: PlateRecipe,
  seconds: number,
  dpr: number,
): Promise<Uint8Array> {
  const target = gpu.createTexture({
    size: [WIDTH, HEIGHT],
    format: FORMAT,
    usage: USAGE.renderAttachment | USAGE.textureCopySrc,
  });
  const uniforms = gpu.createBuffer({ size: PLATE_UNIFORM_BYTES, usage: USAGE.uniform | USAGE.copyDst });
  gpu.queue.writeBuffer(uniforms, 0, plateUniforms(recipe, seconds, WIDTH, HEIGHT, dpr));
  const readback = gpu.createBuffer({ size: BYTES_PER_ROW * HEIGHT, usage: USAGE.copyDst | USAGE.mapRead });
  const encoder = gpu.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] }],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(
    0,
    gpu.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniforms } }],
    }),
  );
  pass.draw(3);
  pass.end();
  encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow: BYTES_PER_ROW }, [WIDTH, HEIGHT]);
  gpu.queue.submit([encoder.finish()]);
  await readback.mapAsync(USAGE.read);
  const rows = new Uint8Array(readback.getMappedRange());
  const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++)
    pixels.set(rows.subarray(y * BYTES_PER_ROW, y * BYTES_PER_ROW + WIDTH * 4), y * WIDTH * 4);
  readback.unmap();
  target.destroy();
  uniforms.destroy();
  readback.destroy();
  return pixels;
}

/** How many pixels are not fully opaque. */
function seeThrough(pixels: Uint8Array): number {
  let count = 0;
  for (let at = 3; at < pixels.length; at += 4) if (pixels[at] !== 255) count += 1;
  return count;
}

/** How many distinct colours the plate holds. */
function colours(pixels: Uint8Array): number {
  const seen = new Set<number>();
  for (let at = 0; at < pixels.length; at += 4)
    seen.add(((pixels[at] ?? 0) << 16) | ((pixels[at + 1] ?? 0) << 8) | (pixels[at + 2] ?? 0));
  return seen.size;
}

describe("Pro nameplate shaders", () => {
  before(async () => {
    try {
      const { init } = await import("vgpu/node");
      const gpu = await init();
      release = () => gpu.dispose();
      device = gpu.gpu;
    } catch {
      device = null;
    }
  });

  // A live Dawn device keeps the process running.
  after(() => release?.());

  it("draws the first piece for an index it does not know", () => {
    for (const index of [-1, PLATE_SCENES.length, 2.5])
      assert.equal(plateShader(index), plateShader(0), `index ${index}`);
  });

  for (const [index, scene] of PLATE_SCENES.entries())
    it(`compiles ${scene} and draws it opaque, in real art, moving with its clock`, async (t) => {
      if (!device) return t.skip("no WebGPU adapter on this machine");
      const { module, errors } = await compile(device, index);
      assert.deepEqual(errors, [], `${scene} compiles`);
      device.pushErrorScope("validation");
      const pipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "vs_main" },
        fragment: { module, entryPoint: "fs_main", targets: [{ format: FORMAT }] },
      });
      const frames: Uint8Array[] = [];
      for (const draw of DRAWS)
        frames.push(await render(device, pipeline, onPiece(index, draw.id, draw.variant), draw.seconds, draw.dpr));
      const first = DRAWS[0];
      const later = await render(
        device,
        pipeline,
        onPiece(index, first.id, first.variant),
        first.seconds + 1.5,
        first.dpr,
      );
      const invalid = await device.popErrorScope();
      assert.equal(invalid?.message ?? null, null, `${scene} draws without a validation error`);
      for (const [at, draw] of DRAWS.entries()) {
        const pixels = frames[at] ?? new Uint8Array();
        assert.equal(seeThrough(pixels), 0, `${scene} for ${draw.id} is opaque`);
        const count = colours(pixels);
        assert.ok(count > MIN_COLOURS, `${scene} for ${draw.id} drew ${count} colours`);
      }
      assert.notDeepEqual(frames[0], frames[1], `${scene} differs between accounts`);
      assert.notDeepEqual(later, frames[0], `${scene} moves with its clock`);
    });
});
