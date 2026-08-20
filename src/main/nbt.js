'use strict';

/**
 * Минимальный читатель/писатель NBT — формата, в котором Minecraft хранит данные.
 * Нужен ровно для одного: править servers.dat, чтобы серверы друзей появлялись
 * в игровом списке «Сетевая игра». servers.dat лежит без сжатия, в отличие от level.dat.
 *
 * Теги представлены как { type, value }, чтобы при перезаписи файла
 * сохранились типы полей, которых мы не трогаем (иконки, флаги ресурспаков).
 */

const TAG = {
  END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6,
  BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12,
};

class Reader {
  constructor(buffer) {
    this.buf = buffer;
    this.pos = 0;
  }
  byte() { const v = this.buf.readInt8(this.pos); this.pos += 1; return v; }
  short() { const v = this.buf.readInt16BE(this.pos); this.pos += 2; return v; }
  int() { const v = this.buf.readInt32BE(this.pos); this.pos += 4; return v; }
  long() { const v = this.buf.readBigInt64BE(this.pos); this.pos += 8; return v; }
  float() { const v = this.buf.readFloatBE(this.pos); this.pos += 4; return v; }
  double() { const v = this.buf.readDoubleBE(this.pos); this.pos += 8; return v; }
  string() {
    const len = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    const v = this.buf.toString('utf8', this.pos, this.pos + len);
    this.pos += len;
    return v;
  }
  payload(type) {
    switch (type) {
      case TAG.BYTE: return this.byte();
      case TAG.SHORT: return this.short();
      case TAG.INT: return this.int();
      case TAG.LONG: return this.long();
      case TAG.FLOAT: return this.float();
      case TAG.DOUBLE: return this.double();
      case TAG.STRING: return this.string();
      case TAG.BYTE_ARRAY: {
        const len = this.int();
        const v = this.buf.subarray(this.pos, this.pos + len);
        this.pos += len;
        return Buffer.from(v);
      }
      case TAG.INT_ARRAY: {
        const len = this.int();
        const out = [];
        for (let i = 0; i < len; i++) out.push(this.int());
        return out;
      }
      case TAG.LONG_ARRAY: {
        const len = this.int();
        const out = [];
        for (let i = 0; i < len; i++) out.push(this.long());
        return out;
      }
      case TAG.LIST: {
        const itemType = this.byte();
        const len = this.int();
        const items = [];
        for (let i = 0; i < len; i++) items.push(this.payload(itemType));
        return { itemType, items };
      }
      case TAG.COMPOUND: {
        const entries = {};
        while (true) {
          const t = this.byte();
          if (t === TAG.END) break;
          const name = this.string();
          entries[name] = { type: t, value: this.payload(t) };
        }
        return entries;
      }
      default:
        throw new Error('Неизвестный тег NBT: ' + type);
    }
  }
}

class Writer {
  constructor() {
    this.chunks = [];
  }
  push(buf) { this.chunks.push(buf); }
  byte(v) { const b = Buffer.alloc(1); b.writeInt8(v); this.push(b); }
  short(v) { const b = Buffer.alloc(2); b.writeInt16BE(v); this.push(b); }
  int(v) { const b = Buffer.alloc(4); b.writeInt32BE(v); this.push(b); }
  long(v) { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(v)); this.push(b); }
  float(v) { const b = Buffer.alloc(4); b.writeFloatBE(v); this.push(b); }
  double(v) { const b = Buffer.alloc(8); b.writeDoubleBE(v); this.push(b); }
  string(v) {
    const data = Buffer.from(String(v), 'utf8');
    const len = Buffer.alloc(2);
    len.writeUInt16BE(data.length);
    this.push(len);
    this.push(data);
  }
  payload(type, value) {
    switch (type) {
      case TAG.BYTE: return this.byte(value);
      case TAG.SHORT: return this.short(value);
      case TAG.INT: return this.int(value);
      case TAG.LONG: return this.long(value);
      case TAG.FLOAT: return this.float(value);
      case TAG.DOUBLE: return this.double(value);
      case TAG.STRING: return this.string(value);
      case TAG.BYTE_ARRAY: {
        const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
        this.int(buf.length);
        return this.push(buf);
      }
      case TAG.INT_ARRAY: {
        this.int(value.length);
        for (const v of value) this.int(v);
        return undefined;
      }
      case TAG.LONG_ARRAY: {
        this.int(value.length);
        for (const v of value) this.long(v);
        return undefined;
      }
      case TAG.LIST: {
        // Пустой список принято помечать типом END
        const itemType = value.items.length ? value.itemType : TAG.END;
        this.byte(itemType);
        this.int(value.items.length);
        for (const item of value.items) this.payload(itemType, item);
        return undefined;
      }
      case TAG.COMPOUND: {
        for (const [name, tag] of Object.entries(value)) {
          this.byte(tag.type);
          this.string(name);
          this.payload(tag.type, tag.value);
        }
        this.byte(TAG.END);
        return undefined;
      }
      default:
        throw new Error('Неизвестный тег NBT: ' + type);
    }
  }
  toBuffer() { return Buffer.concat(this.chunks); }
}

/** Читает несжатый NBT и возвращает { name, value } корневого compound. */
function read(buffer) {
  const r = new Reader(buffer);
  const type = r.byte();
  if (type !== TAG.COMPOUND) throw new Error('Корень NBT не является compound');
  const name = r.string();
  return { name, value: r.payload(TAG.COMPOUND) };
}

function write(name, compound) {
  const w = new Writer();
  w.byte(TAG.COMPOUND);
  w.string(name || '');
  w.payload(TAG.COMPOUND, compound);
  return w.toBuffer();
}

module.exports = { read, write, TAG };
