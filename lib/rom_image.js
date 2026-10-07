// The 32 MiB wave ROM as one image of little-endian 32-bit words, and the 4 files it is split into.
//
// The SWP30 has a 32-bit ROM bus with two 16-bit mask ROMs on it, twice: one pair holds words 000000H - 3FFFFFH and
// the other 400000H - 7FFFFFH, one ROM of each pair the low 16 bits and the other the high 16 bits. Each file is one
// of these ROMs: 8 MiB, 16-bit words in little-endian order.

export const ROM_DWORDS  = 0x800000;
export const PAIR_DWORDS = ROM_DWORDS / 2;
export const PAIR_COUNT  = 2;
export const FILE_SIZE   = PAIR_DWORDS * 2;

const WAVE_BLOCK_BYTES = 64;

export const ROM_FILES = [
	{pairNo: 0, isHigh: false},
	{pairNo: 0, isHigh: true},
	{pairNo: 1, isHigh: false},
	{pairNo: 1, isHigh: true},
];

// "mu2000_wave_000_low.bin": the model, where the pair starts in the image in units of 64 KiB, and which half.
export function makeFileName(modelName, fileNo) {
	const {pairNo, isHigh} = ROM_FILES[fileNo];
	const start = (pairNo * PAIR_DWORDS * 4) >> 16;
	return `${modelName}_wave_${start.toString(16).padStart(3, '0')}_${(isHigh) ? 'high' : 'low'}.bin`;
}

// Known contents, for checking a dump early: the firmware's test mode reads one dword at every power of 2 in each
// 8 MiB quarter and compares them with a table. The MU1000 and the MU2000 have the same table.
// A wrong model, a stuck address line or a byte order mistake shows up here within seconds.
export const KNOWN_DWORDS = [
	[0x000001, 0xa43e33c2], [0x000002, 0x6ac5fa52], [0x000004, 0x57ef7ff7], [0x000008, 0xf0102414], [0x000010, 0x0fcceaad],
	[0x000020, 0xe8ed73c6], [0x000040, 0x2b3ca5f9], [0x000080, 0x81b80080], [0x000100, 0xd9cd80d3], [0x000200, 0xce27f296],
	[0x000400, 0xec9ed8ee], [0x000800, 0x7415c13f], [0x001000, 0xcd5cc4cb], [0x002000, 0xa00800a0], [0x004000, 0x07157401],
	[0x008000, 0x00410038], [0x010000, 0xe26e2be3], [0x020000, 0xc7f41112], [0x040000, 0x20120105], [0x080000, 0x9c112824],
	[0x100000, 0xfd9fd5fd],
	[0x200001, 0x04030201], [0x200002, 0x06070605], [0x200004, 0x02020102], [0x200008, 0xfbfaf9fa], [0x200010, 0x01020303],
	[0x200020, 0xfbfbfcfc], [0x200040, 0x05030202], [0x200080, 0xfdfefeff], [0x200100, 0xfdfcfbfb], [0x200200, 0xfcfcfcfc],
	[0x200400, 0xfefefffe], [0x200800, 0xf7f70102], [0x201000, 0xa89e1738], [0x202000, 0x80130220], [0x204000, 0x01201501],
	[0x208000, 0xf80fbeff], [0x210000, 0x016c1701], [0x220000, 0xcb00003d], [0x240000, 0xf30f50f7], [0x280000, 0x84890900],
	[0x300000, 0xccc4ad8e],
	[0x400001, 0xa1ee2422], [0x400002, 0x0c810b16], [0x400004, 0x9fdffec0], [0x400008, 0x0450a10f], [0x400010, 0xee19e77e],
	[0x400020, 0xed1f09f6], [0x400040, 0x3dffe4de], [0x400080, 0xf46f80fd], [0x400100, 0x4d12d31d], [0x400200, 0x1241801b],
	[0x400400, 0xdecfe76e], [0x400800, 0x09e0f615], [0x401000, 0x837e3c23], [0x402000, 0x1b0af1d5], [0x404000, 0x8f868c87],
	[0x408000, 0x37181c14], [0x410000, 0x090f06f8], [0x420000, 0xfe16272c], [0x440000, 0x160e0286], [0x480000, 0x00d100e0],
	[0x500000, 0xcc15c011],
	[0x600001, 0x0a07080a], [0x600002, 0x84040505], [0x600004, 0xbcb3aba5], [0x600008, 0x88090808], [0x600010, 0x01018185],
	[0x600020, 0x01040c10], [0x600040, 0xd8cabcb0], [0x600080, 0x96938f8d], [0x600100, 0x8a898501], [0x600200, 0x82848586],
	[0x600400, 0x84830207], [0x600800, 0x00050810], [0x601000, 0x00000181], [0x602000, 0x191a130d], [0x604000, 0x070a0c0e],
	[0x608000, 0xaba38a8a], [0x610000, 0xc3b3aea9], [0x620000, 0x12813615], [0x640000, 0x60370460], [0x680000, 0x4f665a3b],
	[0x700000, 0x8a8a8b8b],
];

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) {
		c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
	}
	return c;
});

function calcCrc32(bytes) {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

export class RomImage {
	constructor() {
		this.bytes = new Uint8Array(ROM_DWORDS * 4).fill(0xff);
		this.doneDwords = [0, 0];	// per pair: dwords received from the start of the pair, without a gap
	}

	// Blocks arrive in address order inside a pair, so what is done is always a prefix of the pair.
	putBlock(dwordAddr, bytes) {
		console.assert(bytes.length % 4 === 0 && dwordAddr + bytes.length / 4 <= ROM_DWORDS);
		const pairNo = Math.floor(dwordAddr / PAIR_DWORDS);
		const offset = dwordAddr - pairNo * PAIR_DWORDS;
		console.assert(offset === this.doneDwords[pairNo], 'blocks must arrive in order');
		this.bytes.set(bytes, dwordAddr * 4);
		this.doneDwords[pairNo] = offset + bytes.length / 4;
	}

	// Takes `bytes` (little-endian dwords from address 0) as already received: used to resume.
	restore(bytes) {
		console.assert(bytes.length % (WAVE_BLOCK_BYTES) === 0 && bytes.length <= this.bytes.length);
		this.bytes.set(bytes, 0);
		const dwords = bytes.length / 4;
		this.doneDwords = [Math.min(dwords, PAIR_DWORDS), Math.max(0, dwords - PAIR_DWORDS)];
	}

	// Forgets what was read of one pair, before it is read again.
	clearPair(pairNo) {
		this.bytes.fill(0xff, pairNo * PAIR_DWORDS * 4, (pairNo + 1) * PAIR_DWORDS * 4);
		this.doneDwords[pairNo] = 0;
	}

	// The dwords done from address 0 without a gap: where a whole-ROM dump continues from.
	getResumeDword() {
		return (this.doneDwords[0] < PAIR_DWORDS) ? this.doneDwords[0] : PAIR_DWORDS + this.doneDwords[1];
	}

	isPairComplete(pairNo) {
		return this.doneDwords[pairNo] === PAIR_DWORDS;
	}

	// Bytes of one file that are done so far (each dword gives the file 2 bytes).
	getFileDoneBytes(fileNo) {
		return this.doneDwords[ROM_FILES[fileNo].pairNo] * 2;
	}

	// One of the 4 files: every other 16-bit word of the pair's half of the image.
	getFileBytes(fileNo) {
		const {pairNo, isHigh} = ROM_FILES[fileNo];
		const out = new Uint8Array(FILE_SIZE);
		const base = pairNo * PAIR_DWORDS * 4 + ((isHigh) ? 2 : 0);
		for (let i = 0; i < PAIR_DWORDS; i++) {
			out[2 * i] = this.bytes[base + 4 * i];
			out[2 * i + 1] = this.bytes[base + 4 * i + 1];
		}
		return out;
	}

	// Shown to the user when a file is complete, to compare with a dump made in another way.
	calcFileCrc32(fileNo) {
		return calcCrc32(this.getFileBytes(fileNo));
	}

	// Compares the known dwords inside what is done: {matched, mismatched: [{addr, expected, actual}]}.
	checkKnownWords() {
		const result = {matched: 0, mismatched: []};
		for (const [addr, expected] of KNOWN_DWORDS) {
			const pairNo = Math.floor(addr / PAIR_DWORDS);
			if (addr - pairNo * PAIR_DWORDS >= this.doneDwords[pairNo]) {
				continue;
			}
			const actual = this.readDword(addr);
			if (actual === expected) {
				result.matched++;
			} else {
				result.mismatched.push({addr, expected, actual});
			}
		}
		return result;
	}

	readDword(dwordAddr) {
		const offset = dwordAddr * 4;
		return (this.bytes[offset] | (this.bytes[offset + 1] << 8) | (this.bytes[offset + 2] << 16) | (this.bytes[offset + 3] << 24)) >>> 0;
	}
}
