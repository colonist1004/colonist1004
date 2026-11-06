// Writes a still pose as a VRMA (VRM animation, binary glTF) file. Used by "지금 포즈 저장".
// The pose comes from the renderer as VRM 1.0 normalized bones: for each humanoid bone its parent,
// its rest offset from the parent (meters, facing +Z) and its rotation from that rest (x, y, z, w).

/**
 * @param {{ bones: Record<string, { parent: string|null, t: number[], q: number[] }>, hips: number[] }} pose
 * @returns {Buffer} the .vrma bytes
 */
function writePoseVrma(pose, name = 'pose') {
  const names = Object.keys(pose.bones);
  if (!names.includes('hips')) throw new Error('pose has no hips');
  const json = {
    asset: { version: '2.0', generator: 'desktop-dancer pose save' },
    scene: 0,
    scenes: [{ nodes: [] }],
    nodes: [],
    buffers: [],
    bufferViews: [],
    accessors: [],
  };
  const chunks = [];
  let length = 0;
  const accessor = (arr, type, minMax) => {
    const bytes = Buffer.from(new Float32Array(arr).buffer);
    json.bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.length });
    chunks.push(bytes);
    length += bytes.length; // floats: always 4-byte aligned
    const n = { SCALAR: 1, VEC3: 3, VEC4: 4 }[type];
    const a = { bufferView: json.bufferViews.length - 1, componentType: 5126, count: arr.length / n, type };
    if (minMax) Object.assign(a, { min: [Math.min(...arr)], max: [Math.max(...arr)] });
    json.accessors.push(a);
    return json.accessors.length - 1;
  };

  const index = {};
  for (const n of names) {
    index[n] = json.nodes.length;
    json.nodes.push({ name: n, translation: pose.bones[n].t.map(Number) });
  }
  for (const n of names) {
    const p = pose.bones[n].parent;
    if (p && index[p] != null) (json.nodes[index[p]].children ||= []).push(index[n]);
    else json.scenes[0].nodes.push(index[n]);
  }

  // two identical keys one second apart, like the bundled poses (the app adds breathing)
  const input = accessor([0, 1], 'SCALAR', true);
  const samplers = [];
  const channels = [];
  const add = (node, path, values, type) => {
    samplers.push({ input, output: accessor([...values, ...values], type), interpolation: 'LINEAR' });
    channels.push({ sampler: samplers.length - 1, target: { node, path } });
  };
  add(index.hips, 'translation', pose.hips.map(Number), 'VEC3');
  for (const n of names) {
    const q = pose.bones[n].q.map(Number);
    const len = Math.hypot(...q) || 1;
    add(index[n], 'rotation', q.map((v) => v / len), 'VEC4');
  }
  json.animations = [{ name, samplers, channels }];
  json.extensionsUsed = ['VRMC_vrm_animation'];
  json.extensions = {
    VRMC_vrm_animation: {
      specVersion: '1.0',
      humanoid: { humanBones: Object.fromEntries(names.map((n) => [n, { node: index[n] }])) },
    },
  };

  const bin = Buffer.concat(chunks);
  json.buffers.push({ byteLength: bin.length });
  let js = Buffer.from(JSON.stringify(json), 'utf8');
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const binPad = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + js.length + 8 + binPad.length, 8);
  const ch = (len, type) => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(len, 0);
    b.writeUInt32LE(type, 4);
    return b;
  };
  return Buffer.concat([header, ch(js.length, 0x4e4f534a), js, ch(binPad.length, 0x004e4942), binPad]);
}

module.exports = { writePoseVrma };
