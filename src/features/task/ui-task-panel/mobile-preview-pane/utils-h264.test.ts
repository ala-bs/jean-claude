import { describe, expect, it } from 'vitest';

import { containsH264Keyframe, createH264AccessUnitParser } from './utils-h264';

const START = [0x00, 0x00, 0x00, 0x01];

function nal(header: number, ...payload: number[]) {
  return [...START, header, ...payload];
}

class BitWriter {
  private bits: number[] = [];

  writeBits(value: number, count: number) {
    for (let index = count - 1; index >= 0; index -= 1) {
      this.bits.push((value >> index) & 1);
    }
  }

  writeBool(value: boolean) {
    this.writeBits(value ? 1 : 0, 1);
  }

  writeUnsignedExpGolomb(value: number) {
    const codeNum = value + 1;
    const bitLength = Math.floor(Math.log2(codeNum)) + 1;
    for (let index = 0; index < bitLength - 1; index += 1) {
      this.bits.push(0);
    }
    this.writeBits(codeNum, bitLength);
  }

  bytes() {
    this.bits.push(1);
    while (this.bits.length % 8 !== 0) this.bits.push(0);
    const bytes: number[] = [];
    for (let index = 0; index < this.bits.length; index += 8) {
      bytes.push(
        this.bits
          .slice(index, index + 8)
          .reduce((value, bit) => (value << 1) | bit, 0),
      );
    }
    return bytes;
  }
}

function minimalSps() {
  const writer = new BitWriter();
  writer.writeBits(0x42, 8);
  writer.writeBits(0, 8);
  writer.writeBits(0x1e, 8);
  writer.writeUnsignedExpGolomb(0);
  writer.writeUnsignedExpGolomb(0);
  writer.writeUnsignedExpGolomb(0);
  writer.writeUnsignedExpGolomb(0);
  writer.writeUnsignedExpGolomb(0);
  writer.writeBool(false);
  writer.writeUnsignedExpGolomb(0);
  writer.writeUnsignedExpGolomb(0);
  writer.writeBool(true);
  return nal(0x67, ...writer.bytes());
}

function minimalPps() {
  const writer = new BitWriter();
  writer.writeUnsignedExpGolomb(0);
  writer.writeUnsignedExpGolomb(0);
  writer.writeBool(false);
  writer.writeBool(false);
  return nal(0x68, ...writer.bytes());
}

function slice(frameNum: number, picOrderCntLsb: number) {
  const writer = new BitWriter();
  writer.writeUnsignedExpGolomb(0);
  writer.writeUnsignedExpGolomb(0);
  writer.writeUnsignedExpGolomb(0);
  writer.writeBits(frameNum, 4);
  writer.writeBits(picOrderCntLsb, 4);
  return nal(0x41, ...writer.bytes());
}

describe('createH264AccessUnitParser', () => {
  it('keeps non-first slices in the same access unit', () => {
    const parser = createH264AccessUnitParser();
    const chunk = new Uint8Array([
      ...nal(0x67, 0x64, 0x00, 0x32, 0xac),
      ...nal(0x68, 0xee, 0x3c),
      ...nal(0x41, 0x80),
      ...nal(0x41, 0x40),
      ...nal(0x41, 0x80),
      ...START,
    ]);

    const units = parser(chunk);

    expect(units).toHaveLength(1);
    expect(units[0].configuration).toBeInstanceOf(Uint8Array);
    expect(units[0].data).toHaveLength(12);
  });

  it('emits a pending access unit before applying new parameter sets', () => {
    const parser = createH264AccessUnitParser();
    const chunk = new Uint8Array([
      ...nal(0x67, 0x64, 0x00, 0x32, 0xac),
      ...nal(0x68, 0xee, 0x3c),
      ...nal(0x41, 0x80),
      ...nal(0x67, 0x42, 0x00, 0x1e, 0xac),
      ...nal(0x68, 0xdd, 0x3c),
      ...nal(0x41, 0x80),
      ...START,
    ]);

    const units = parser(chunk);

    expect(units).toHaveLength(1);
    expect(Array.from(units[0].configuration?.slice(4, 8) ?? [])).toEqual([
      0x67, 0x64, 0x00, 0x32,
    ]);
  });

  it('splits slices with different frame numbers into separate access units', () => {
    const parser = createH264AccessUnitParser();
    const chunk = new Uint8Array([
      ...minimalSps(),
      ...minimalPps(),
      ...slice(0, 0),
      ...slice(1, 2),
      ...slice(2, 4),
      ...START,
    ]);

    const units = parser(chunk);

    expect(units).toHaveLength(2);
    expect(units[0].configuration).toBeInstanceOf(Uint8Array);
    expect(units[1].configuration).toBeNull();
    expect(units[0].data).toHaveLength(7);
    expect(units[1].data).toHaveLength(7);
  });
});

describe('containsH264Keyframe', () => {
  it('detects IDR NAL units in Annex B data', () => {
    expect(
      containsH264Keyframe(new Uint8Array([...nal(0x41, 0x80), ...nal(0x65)])),
    ).toBe(true);
  });

  it('ignores non-IDR slices', () => {
    expect(containsH264Keyframe(new Uint8Array(nal(0x41, 0x80)))).toBe(false);
  });
});
