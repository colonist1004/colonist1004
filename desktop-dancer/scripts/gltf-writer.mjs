// Minimal GLB (binary glTF 2.0) writer. No dependencies.
// Used to produce the bundled sample character (.vrm) and sample dance (.vrma).

export class GltfBuilder {
  constructor() {
    this.json = {
      asset: { version: '2.0', generator: 'desktop-dancer make-samples' },
      scene: 0,
      scenes: [{ nodes: [] }],
      nodes: [],
      buffers: [],
      bufferViews: [],
      accessors: [],
    };
    this.chunks = [];
    this.byteLength = 0;
  }

  /** Append raw bytes to the single binary buffer, returns bufferView index. */
  addBufferView(typedArray, target) {
    const pad = (4 - (this.byteLength % 4)) % 4;
    if (pad) {
      this.chunks.push(new Uint8Array(pad));
      this.byteLength += pad;
    }
    const bytes = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
    this.chunks.push(bytes);
    const view = { buffer: 0, byteOffset: this.byteLength, byteLength: bytes.byteLength };
    if (target) view.target = target;
    this.byteLength += bytes.byteLength;
    this.json.bufferViews.push(view);
    return this.json.bufferViews.length - 1;
  }

  /** type: SCALAR | VEC3 | VEC4; data: Float32Array | Uint16Array */
  addAccessor(data, type, { target, minMax = false } = {}) {
    const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type];
    const componentType = data instanceof Float32Array ? 5126 : data instanceof Uint16Array ? 5123 : 5125;
    const accessor = {
      bufferView: this.addBufferView(data, target),
      componentType,
      count: data.length / comps,
      type,
    };
    if (minMax) {
      const min = new Array(comps).fill(Infinity);
      const max = new Array(comps).fill(-Infinity);
      for (let i = 0; i < data.length; i++) {
        const c = i % comps;
        min[c] = Math.min(min[c], data[i]);
        max[c] = Math.max(max[c], data[i]);
      }
      accessor.min = min;
      accessor.max = max;
    }
    this.json.accessors.push(accessor);
    return this.json.accessors.length - 1;
  }

  addNode(node) {
    this.json.nodes.push(node);
    return this.json.nodes.length - 1;
  }

  toGlb() {
    const bin = new Uint8Array(Math.ceil(this.byteLength / 4) * 4);
    let off = 0;
    for (const c of this.chunks) {
      bin.set(c, off);
      off += c.byteLength;
    }
    if (bin.byteLength) this.json.buffers.push({ byteLength: bin.byteLength });
    else delete this.json.buffers;
    for (const k of ['bufferViews', 'accessors']) if (!this.json[k].length) delete this.json[k];

    let jsonBytes = new TextEncoder().encode(JSON.stringify(this.json));
    const jsonPad = (4 - (jsonBytes.byteLength % 4)) % 4;
    const jsonChunk = new Uint8Array(jsonBytes.byteLength + jsonPad).fill(0x20);
    jsonChunk.set(jsonBytes);

    const total = 12 + 8 + jsonChunk.byteLength + (bin.byteLength ? 8 + bin.byteLength : 0);
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546c67, true); // 'glTF'
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, jsonChunk.byteLength, true);
    dv.setUint32(16, 0x4e4f534a, true); // 'JSON'
    out.set(jsonChunk, 20);
    if (bin.byteLength) {
      const o = 20 + jsonChunk.byteLength;
      dv.setUint32(o, bin.byteLength, true);
      dv.setUint32(o + 4, 0x004e4942, true); // 'BIN\0'
      out.set(bin, o + 8);
    }
    return out;
  }
}
