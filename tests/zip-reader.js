'use strict';
// Независимая от расширения проверка ZIP: разбор каталога (в том числе ZIP64),
// распаковка через zlib из Node и сверка CRC. Используют модульные и браузерные тесты.
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

/** Независимое чтение ZIP: центральный каталог, ZIP64, распаковка и сверка CRC средствами Node. */
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'есть конец центрального каталога');
  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  let zip64 = false;
  if (count === 0xffff || cdOffset === 0xffffffff) {
    zip64 = true;
    const loc = eocd - 20;
    assert.equal(buf.readUInt32LE(loc), 0x07064b50, 'локатор ZIP64');
    const rec = Number(buf.readBigUInt64LE(loc + 8));
    assert.equal(buf.readUInt32LE(rec), 0x06064b50, 'запись ZIP64');
    count = Number(buf.readBigUInt64LE(rec + 32));
    cdOffset = Number(buf.readBigUInt64LE(rec + 48));
  }
  const out = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'запись каталога');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    let packed = buf.readUInt32LE(p + 20);
    let size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    let mtime = null;
    for (let x = p + 46 + nameLen; x < p + 46 + nameLen + extraLen; ) {
      const id = buf.readUInt16LE(x);
      const len = buf.readUInt16LE(x + 2);
      let f = x + 4;
      if (id === 0x0001) {
        if (size === 0xffffffff) (size = Number(buf.readBigUInt64LE(f))), (f += 8);
        if (packed === 0xffffffff) (packed = Number(buf.readBigUInt64LE(f))), (f += 8);
        if (offset === 0xffffffff) offset = Number(buf.readBigUInt64LE(f));
      } else if (id === 0x5455) mtime = buf.readUInt32LE(x + 5);
      x += 4 + len;
    }
    assert.equal(buf.readUInt32LE(offset), 0x04034b50, 'локальный заголовок ' + name);
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const raw = buf.subarray(start, start + packed);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    assert.equal(data.length, size, 'размер ' + name);
    assert.equal(zlib.crc32(data), crc, 'CRC ' + name);
    out.push({ name, method, size, packed, data, utf8: !!(flags & 0x800), mtime });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { entries: out, zip64 };
}

module.exports = { readZip };
