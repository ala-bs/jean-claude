export type H264AccessUnit = {
  data: Uint8Array<ArrayBuffer>;
  configuration: Uint8Array<ArrayBuffer> | null;
  isKey: boolean;
};

function findStartCode(bytes: Uint8Array, fromIndex: number): number {
  for (let index = fromIndex; index < bytes.length - 3; index += 1) {
    if (
      bytes[index] === 0x00 &&
      bytes[index + 1] === 0x00 &&
      (bytes[index + 2] === 0x01 ||
        (bytes[index + 2] === 0x00 && bytes[index + 3] === 0x01))
    ) {
      return index;
    }
  }
  return -1;
}

function getStartCodeLength(bytes: Uint8Array, index: number): number {
  return bytes[index + 2] === 0x01 ? 3 : 4;
}

function getNalType(nal: Uint8Array<ArrayBufferLike>): number {
  return nal[getStartCodeLength(nal, 0)] & 0x1f;
}

function getNalPayload(nal: Uint8Array<ArrayBufferLike>): Uint8Array {
  return nal.subarray(getStartCodeLength(nal, 0));
}

function concatAnnexBNals(
  nals: Array<Uint8Array<ArrayBufferLike>>,
): Uint8Array<ArrayBuffer> {
  const totalLength = nals.reduce((sum, nal) => sum + nal.length, 0);
  const sample = new Uint8Array(totalLength);
  let offset = 0;

  for (const nal of nals) {
    sample.set(nal, offset);
    offset += nal.length;
  }

  return sample;
}

function buildAnnexBConfiguration(
  spsNal: Uint8Array<ArrayBufferLike>,
  ppsNal: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBuffer> {
  return concatAnnexBNals([spsNal, ppsNal]);
}

function buildAnnexBFrame(
  nals: Array<Uint8Array<ArrayBufferLike>>,
): Uint8Array<ArrayBuffer> {
  return concatAnnexBNals(
    nals.filter((nal) => {
      const type = getNalType(nal);
      return type !== 7 && type !== 8;
    }),
  );
}

function appendBytes(
  a: Uint8Array<ArrayBufferLike>,
  b: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBuffer> {
  const merged = new Uint8Array(a.length + b.length);
  merged.set(a);
  merged.set(b, a.length);
  return merged;
}

function removeEmulationPreventionBytes(
  bytes: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBuffer> {
  const result: number[] = [];
  for (let index = 0; index < bytes.length; index += 1) {
    if (
      index >= 2 &&
      bytes[index] === 0x03 &&
      bytes[index - 1] === 0x00 &&
      bytes[index - 2] === 0x00
    ) {
      continue;
    }
    result.push(bytes[index]);
  }
  return new Uint8Array(result);
}

class BitReader {
  private bitIndex = 0;

  constructor(private readonly bytes: Uint8Array<ArrayBufferLike>) {}

  readBits(count: number): number | null {
    if (
      count < 0 ||
      count > 31 ||
      this.bitIndex + count > this.bytes.length * 8
    ) {
      return null;
    }

    let value = 0;
    for (let offset = 0; offset < count; offset += 1) {
      const bit =
        (this.bytes[this.bitIndex >> 3] >> (7 - (this.bitIndex % 8))) & 1;
      this.bitIndex += 1;
      value = (value << 1) | bit;
    }
    return value;
  }

  readBool(): boolean | null {
    const value = this.readBits(1);
    return value === null ? null : value === 1;
  }

  readUnsignedExpGolomb(): number | null {
    let leadingZeros = 0;

    while (this.bitIndex < this.bytes.length * 8) {
      const bit = this.readBits(1);
      if (bit === null) return null;
      if (bit === 1) break;
      leadingZeros += 1;
    }

    if (
      leadingZeros > 31 ||
      this.bitIndex + leadingZeros > this.bytes.length * 8
    ) {
      return null;
    }

    const suffix = leadingZeros === 0 ? 0 : this.readBits(leadingZeros);
    if (suffix === null) return null;

    return (1 << leadingZeros) - 1 + suffix;
  }

  readSignedExpGolomb(): number | null {
    const value = this.readUnsignedExpGolomb();
    if (value === null) return null;
    return value % 2 === 0 ? -(value / 2) : (value + 1) / 2;
  }
}

type H264SpsInfo = {
  id: number;
  log2MaxFrameNum: number;
  picOrderCntType: number;
  log2MaxPicOrderCntLsb: number | null;
  frameMbsOnlyFlag: boolean;
};

type H264PpsInfo = {
  id: number;
  spsId: number;
  bottomFieldPicOrderInFramePresentFlag: boolean;
};

type H264SliceHeader = {
  firstMbInSlice: number;
  ppsId: number;
  frameNum: number;
  fieldPicFlag: boolean;
  bottomFieldFlag: boolean;
  nalRefIdc: number;
  nalType: number;
  idrPicId: number | null;
  picOrderCntLsb: number | null;
};

function getRbspAfterNalHeader(nal: Uint8Array<ArrayBufferLike>) {
  return removeEmulationPreventionBytes(getNalPayload(nal).subarray(1));
}

function parseSps(nal: Uint8Array<ArrayBufferLike>): H264SpsInfo | null {
  if (getNalType(nal) !== 7) return null;
  const reader = new BitReader(getRbspAfterNalHeader(nal));
  const profileIdc = reader.readBits(8);
  if (profileIdc === null) return null;
  if (reader.readBits(8) === null || reader.readBits(8) === null) return null;
  const id = reader.readUnsignedExpGolomb();
  if (id === null) return null;

  if (
    [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(
      profileIdc,
    )
  ) {
    const chromaFormatIdc = reader.readUnsignedExpGolomb();
    if (chromaFormatIdc === null) return null;
    if (chromaFormatIdc === 3 && reader.readBits(1) === null) return null;
    if (
      reader.readUnsignedExpGolomb() === null ||
      reader.readUnsignedExpGolomb() === null ||
      reader.readBits(1) === null
    ) {
      return null;
    }
    const seqScalingMatrixPresentFlag = reader.readBool();
    if (seqScalingMatrixPresentFlag === null) return null;
    if (seqScalingMatrixPresentFlag) return null;
  }

  const log2MaxFrameNumMinus4 = reader.readUnsignedExpGolomb();
  const picOrderCntType = reader.readUnsignedExpGolomb();
  if (log2MaxFrameNumMinus4 === null || picOrderCntType === null) return null;

  let log2MaxPicOrderCntLsb: number | null = null;
  if (picOrderCntType === 0) {
    const log2MaxPicOrderCntLsbMinus4 = reader.readUnsignedExpGolomb();
    if (log2MaxPicOrderCntLsbMinus4 === null) return null;
    log2MaxPicOrderCntLsb = log2MaxPicOrderCntLsbMinus4 + 4;
  } else if (picOrderCntType === 1) {
    if (
      reader.readBits(1) === null ||
      reader.readSignedExpGolomb() === null ||
      reader.readSignedExpGolomb() === null
    ) {
      return null;
    }
    const cycles = reader.readUnsignedExpGolomb();
    if (cycles === null) return null;
    for (let index = 0; index < cycles; index += 1) {
      if (reader.readSignedExpGolomb() === null) return null;
    }
  }

  if (
    reader.readUnsignedExpGolomb() === null ||
    reader.readBits(1) === null ||
    reader.readUnsignedExpGolomb() === null ||
    reader.readUnsignedExpGolomb() === null
  ) {
    return null;
  }
  const frameMbsOnlyFlag = reader.readBool();
  if (frameMbsOnlyFlag === null) return null;

  return {
    id,
    log2MaxFrameNum: log2MaxFrameNumMinus4 + 4,
    picOrderCntType,
    log2MaxPicOrderCntLsb,
    frameMbsOnlyFlag,
  };
}

function parsePps(nal: Uint8Array<ArrayBufferLike>): H264PpsInfo | null {
  if (getNalType(nal) !== 8) return null;
  const reader = new BitReader(getRbspAfterNalHeader(nal));
  const id = reader.readUnsignedExpGolomb();
  const spsId = reader.readUnsignedExpGolomb();
  if (id === null || spsId === null) return null;
  if (reader.readBits(1) === null) return null;
  const bottomFieldPicOrderInFramePresentFlag = reader.readBool();
  if (bottomFieldPicOrderInFramePresentFlag === null) return null;

  return { id, spsId, bottomFieldPicOrderInFramePresentFlag };
}

function parseSliceHeader(
  nal: Uint8Array<ArrayBufferLike>,
  ppsById: Map<number, H264PpsInfo>,
  spsById: Map<number, H264SpsInfo>,
): H264SliceHeader | null {
  const nalType = getNalType(nal);
  if (nalType !== 1 && nalType !== 5) return null;

  const payload = getNalPayload(nal);
  const nalRefIdc = (payload[0] >> 5) & 0x03;
  const reader = new BitReader(
    removeEmulationPreventionBytes(payload.subarray(1)),
  );
  const firstMbInSlice = reader.readUnsignedExpGolomb();
  if (firstMbInSlice === null) return null;
  if (reader.readUnsignedExpGolomb() === null) return null;
  const ppsId = reader.readUnsignedExpGolomb();
  if (ppsId === null)
    return {
      firstMbInSlice,
      ppsId: -1,
      frameNum: -1,
      fieldPicFlag: false,
      bottomFieldFlag: false,
      nalRefIdc,
      nalType,
      idrPicId: null,
      picOrderCntLsb: null,
    };
  const pps = ppsById.get(ppsId);
  const sps = pps ? spsById.get(pps.spsId) : null;
  if (!pps || !sps)
    return {
      firstMbInSlice,
      ppsId,
      frameNum: -1,
      fieldPicFlag: false,
      bottomFieldFlag: false,
      nalRefIdc,
      nalType,
      idrPicId: null,
      picOrderCntLsb: null,
    };

  const frameNum = reader.readBits(sps.log2MaxFrameNum);
  if (frameNum === null) return null;

  let fieldPicFlag = false;
  let bottomFieldFlag = false;
  if (!sps.frameMbsOnlyFlag) {
    const fieldPicFlagValue = reader.readBool();
    if (fieldPicFlagValue === null) return null;
    fieldPicFlag = fieldPicFlagValue;
    if (fieldPicFlag) {
      const bottomFieldFlagValue = reader.readBool();
      if (bottomFieldFlagValue === null) return null;
      bottomFieldFlag = bottomFieldFlagValue;
    }
  }

  const idrPicId = nalType === 5 ? reader.readUnsignedExpGolomb() : null;
  if (nalType === 5 && idrPicId === null) return null;

  let picOrderCntLsb: number | null = null;
  if (sps.picOrderCntType === 0 && sps.log2MaxPicOrderCntLsb !== null) {
    picOrderCntLsb = reader.readBits(sps.log2MaxPicOrderCntLsb);
    if (picOrderCntLsb === null) return null;
  }

  return {
    firstMbInSlice,
    ppsId,
    frameNum,
    fieldPicFlag,
    bottomFieldFlag,
    nalRefIdc,
    nalType,
    idrPicId,
    picOrderCntLsb,
  };
}

function getFirstMbInSlice(nal: Uint8Array<ArrayBufferLike>): number | null {
  const nalType = getNalType(nal);
  if (nalType !== 1 && nalType !== 5) return null;

  return new BitReader(getRbspAfterNalHeader(nal)).readUnsignedExpGolomb();
}

function isDifferentPicture(
  current: H264SliceHeader,
  next: H264SliceHeader,
): boolean {
  if (current.frameNum < 0 || next.frameNum < 0) {
    return next.firstMbInSlice === 0;
  }

  return (
    current.frameNum !== next.frameNum ||
    current.ppsId !== next.ppsId ||
    current.fieldPicFlag !== next.fieldPicFlag ||
    current.bottomFieldFlag !== next.bottomFieldFlag ||
    (current.nalRefIdc === 0) !== (next.nalRefIdc === 0) ||
    (current.nalType === 5) !== (next.nalType === 5) ||
    current.idrPicId !== next.idrPicId ||
    current.picOrderCntLsb !== next.picOrderCntLsb
  );
}

function startsNewAccessUnit(
  nal: Uint8Array<ArrayBufferLike>,
  currentHasVcl: boolean,
  currentSliceHeader: H264SliceHeader | null,
  nextSliceHeader: H264SliceHeader | null,
): boolean {
  if (!currentHasVcl) return false;

  const nalType = getNalType(nal);
  if (nalType === 1 || nalType === 5) {
    if (!nextSliceHeader) return getFirstMbInSlice(nal) === 0;
    if (!currentSliceHeader) return nextSliceHeader.firstMbInSlice === 0;
    return isDifferentPicture(currentSliceHeader, nextSliceHeader);
  }

  return nalType === 6 || nalType === 7 || nalType === 8 || nalType === 9;
}

function containsKeyframe(nals: Array<Uint8Array<ArrayBufferLike>>): boolean {
  return nals.some((nal) => getNalType(nal) === 5);
}

export function containsH264Keyframe(bytes: Uint8Array): boolean {
  let start = findStartCode(bytes, 0);
  if (start === -1) return false;

  while (start !== -1) {
    const next = findStartCode(bytes, start + getStartCodeLength(bytes, start));
    const end = next === -1 ? bytes.length : next;
    const nal = bytes.subarray(start, end);
    if (nal.length > getStartCodeLength(nal, 0) && getNalType(nal) === 5) {
      return true;
    }
    start = next;
  }

  return false;
}

function containsConfiguration(
  nals: Array<Uint8Array<ArrayBufferLike>>,
): boolean {
  return nals.some((nal) => {
    const type = getNalType(nal);
    return type === 7 || type === 8;
  });
}

export function createH264AccessUnitParser() {
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let currentNals: Array<Uint8Array<ArrayBufferLike>> = [];
  let currentHasVcl = false;
  let currentConfiguration: Uint8Array<ArrayBuffer> | null = null;
  let currentSps: Uint8Array<ArrayBufferLike> | null = null;
  let currentPps: Uint8Array<ArrayBufferLike> | null = null;
  let currentSliceHeader: H264SliceHeader | null = null;
  const spsById = new Map<number, H264SpsInfo>();
  const ppsById = new Map<number, H264PpsInfo>();

  return (chunk: Uint8Array): H264AccessUnit[] => {
    pending = appendBytes(pending, chunk);
    const units: H264AccessUnit[] = [];

    let start = findStartCode(pending, 0);
    if (start === -1) {
      if (pending.length > 1024 * 1024) {
        pending = pending.subarray(pending.length - 4);
      }
      return units;
    }

    if (start > 0) {
      pending = pending.subarray(start);
      start = 0;
    }

    while (true) {
      const next = findStartCode(
        pending,
        start + getStartCodeLength(pending, start),
      );
      if (next === -1) break;

      const nal = pending.subarray(start, next);
      const nalType = getNalType(nal);
      const isVcl = nalType === 1 || nalType === 5;
      const nextSliceHeader = isVcl
        ? parseSliceHeader(nal, ppsById, spsById)
        : null;

      if (
        startsNewAccessUnit(
          nal,
          currentHasVcl,
          currentSliceHeader,
          nextSliceHeader,
        ) &&
        currentNals.length > 0
      ) {
        const data = buildAnnexBFrame(currentNals);
        units.push({
          data,
          configuration: containsConfiguration(currentNals)
            ? currentConfiguration
            : null,
          isKey: containsKeyframe(currentNals),
        });
        currentNals = [];
        currentHasVcl = false;
        currentSliceHeader = null;
      }

      if (nalType === 7) {
        currentSps = nal;
        const sps = parseSps(nal);
        if (sps) spsById.set(sps.id, sps);
      } else if (nalType === 8) {
        currentPps = nal;
        const pps = parsePps(nal);
        if (pps) ppsById.set(pps.id, pps);
      }
      if (currentSps && currentPps) {
        currentConfiguration = buildAnnexBConfiguration(currentSps, currentPps);
      }

      currentNals.push(nal);
      currentHasVcl ||= isVcl;
      if (nextSliceHeader && !currentSliceHeader) {
        currentSliceHeader = nextSliceHeader;
      }
      start = next;
    }

    pending = pending.subarray(start);
    return units;
  };
}
