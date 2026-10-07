// The SysEx messages the MU2000 / MU1000 answer with wave ROM data. Two routes:
//
// * Sampling (model ID 68H, MU2000 only): the "wave data" dump request returns 64 bytes from the sampling write
//   position. The position is 28 bits in units of 64 bytes, and the firmware adds the start of the sampling RAM
//   (01000000H) in 32-bit arithmetic, so a position just below 2^32 wraps around to the wave ROM.
// * Registers (model ID 47H to write, 18H 5A 10 to read; MU1000 and MU2000): the SWP30's wave direct access.
//   An address, a word count and a trigger are written, then the data register is read word by word.

export const DEVICE_ALL = 0;		// device number 1, which is also what a synth set to "All" answers on

// ---- model ID 68H (sampling)
const MODEL_SAMPLING = 0x68;

const POSITION_ADDR   = [0x00, 0x00, 0x00];
const FREE_HEAD_ADDR  = [0x00, 0x00, 0x10];
const WAVE_BLOCK_ADDR = [0x00, 0x01, 0x00];

const PACKED_BLOCK_SIZE = 74;

export const WAVE_BLOCK_SIZE   = 64;		// bytes of wave memory in one reply
export const WAVE_BLOCK_DWORDS = WAVE_BLOCK_SIZE / 4;

// F0 43 0n 68 count(2) address(3) data checksum F7. The checksum covers count..data.
function buildBulkDump(addr, data, device) {
	const body = [(data.length >> 7) & 0x7f, data.length & 0x7f, ...addr, ...data];
	return Uint8Array.from([0xf0, 0x43, 0x00 | device, MODEL_SAMPLING, ...body, calcChecksum(body), 0xf7]);
}

function buildDumpRequest(addr, device) {
	return Uint8Array.from([0xf0, 0x43, 0x20 | device, MODEL_SAMPLING, ...addr, 0xf7]);
}

function calcChecksum(bytes) {
	let sum = 0;
	for (const byte of bytes) {
		sum += byte;
	}
	return (-sum) & 0x7f;
}

// A bulk dump taken apart, or null if this is not one.
function parseBulkDump(message) {
	if (message.length < 4 + 2 + 3 + 2 || message[0] !== 0xf0 || message[1] !== 0x43 || (message[2] & 0xf0) !== 0x00 || message[3] !== MODEL_SAMPLING) {
		return null;
	}
	const body = message.slice(4, -2);
	const size = (body[0] << 7) | body[1];

	return {
		device: message[2] & 0x0f,
		addr: Array.from(body.slice(2, 5)),
		data: Uint8Array.from(body.slice(5)),
		isOk: (size === body.length - 5 && calcChecksum(body) === message[message.length - 2]),
	};
}

const isAddr = (reply, addr) => addr.every((byte, i) => (reply.addr[i] === byte));

// Sets the sampling write position so that the next wave data request reads the ROM at `dwordAddr`.
export function buildPositionMessage(dwordAddr, device = DEVICE_ALL) {
	console.assert(dwordAddr % WAVE_BLOCK_DWORDS === 0);
	const position = (0x0ff00000 + dwordAddr / WAVE_BLOCK_DWORDS) & 0x0fffffff;
	const bytes = [(position >> 21) & 0x7f, (position >> 14) & 0x7f, (position >> 7) & 0x7f, position & 0x7f];
	return buildBulkDump(POSITION_ADDR, bytes, device);
}

export function buildWaveBlockRequest(device = DEVICE_ALL) {
	return buildDumpRequest(WAVE_BLOCK_ADDR, device);
}

// The 64 bytes of a wave data reply in image order (little-endian dwords), with `isOk` false when the checksum or
// the size is wrong. Null if the message is something else.
export function parseWaveBlockReply(message) {
	const reply = parseBulkDump(message);
	if (!reply || !isAddr(reply, WAVE_BLOCK_ADDR) || reply.data.length !== PACKED_BLOCK_SIZE) {
		return null;
	}
	// 74 -> 64 bytes: 9 groups of 7 data bytes followed by one byte with their MSBs (bit 6 for the first one),
	// then the 64th byte's low 7 bits and its MSB in bit 0.
	const block = new Uint8Array(WAVE_BLOCK_SIZE);
	const packed = reply.data;
	for (let group = 0; group < 9; group++) {
		const msbs = packed[group * 8 + 7];
		for (let i = 0; i < 7; i++) {
			block[group * 7 + i] = packed[group * 8 + i] | ((msbs & (0x40 >> i)) ? 0x80 : 0x00);
		}
	}
	block[63] = packed[72] | ((packed[73] & 0x01) ? 0x80 : 0x00);
	// The firmware writes each dword as its low 16 bits then its high 16 bits, each big-endian. Swapping the bytes
	// of every pair gives the dword in little-endian order.
	const bytes = new Uint8Array(WAVE_BLOCK_SIZE);
	for (let i = 0; i < WAVE_BLOCK_SIZE; i += 2) {
		bytes[i] = block[i + 1];
		bytes[i + 1] = block[i];
	}

	return {isOk: reply.isOk, bytes};
}

// Asks for the free head of the sampling RAM: a small, harmless request that only an MU2000 answers.
export function buildPingMessage(device = DEVICE_ALL) {
	return buildDumpRequest(FREE_HEAD_ADDR, device);
}

// {device, data} for a reply to the ping, or null.
export function parsePingReply(message) {
	const reply = parseBulkDump(message);
	return (reply && isAddr(reply, FREE_HEAD_ADDR)) ? {device: reply.device, data: reply.data} : null;
}

// ---- model ID 47H (register write) and 18H 5A 10 (register read)
// The SWP30's wave direct access registers, as CPU addresses.
const REG_ADDR_HIGH = 0x80011c;
const REG_ADDR_LOW  = 0x80011e;
const REG_SIZE_HIGH = 0x80019c;
const REG_SIZE_LOW  = 0x80019e;
const REG_TRIGGER   = 0x80021c;
const REG_STATUS    = 0x80021e;
const REG_DATA_HIGH = 0x80029c;
const REG_DATA_LOW  = 0x80029e;

const TRIGGER_ROM_READ = 0x8000;

export const SWP_REGISTER = {STATUS: 'status', DATA_HIGH: 'high', DATA_LOW: 'low'};
const SWP_REGISTER_ADDRS = {[SWP_REGISTER.STATUS]: REG_STATUS, [SWP_REGISTER.DATA_HIGH]: REG_DATA_HIGH, [SWP_REGISTER.DATA_LOW]: REG_DATA_LOW};

// Registers read only to mark the start of a try (see dump.js). Reading them changes nothing, and none of them is a
// register the data is read from. Only the register named in the reply is used: on the real synth, reading these
// back does not give the value written to them.
const MARKER_ADDRS = [REG_ADDR_HIGH, REG_ADDR_LOW, REG_SIZE_HIGH, REG_SIZE_LOW, REG_TRIGGER];
export const MARKER_COUNT = MARKER_ADDRS.length;

// F0 43 1n 47 01 02 00 {i1 i0 v2 v1 v0}... F7: 16-bit writes to registers. The index is (address - 800000H) / 2.
function buildRegisterWrite(pairs, device) {
	const out = [0xf0, 0x43, 0x10 | device, 0x47, 0x01, 0x02, 0x00];
	for (const [addr, value] of pairs) {
		const index = (addr - 0x800000) >> 1;
		out.push((index >> 7) & 0x1f, index & 0x7f, (value >> 14) & 0x03, (value >> 7) & 0x7f, value & 0x7f);
	}
	out.push(0xf7);

	return Uint8Array.from(out);
}

// Starts a ROM read of `dwordCount` dwords at `dwordAddr`: trigger off, address, count, trigger on, in one message.
export function buildFifoStart(dwordAddr, dwordCount, device = DEVICE_ALL) {
	return buildRegisterWrite([
		[REG_TRIGGER, 0],
		[REG_ADDR_HIGH, dwordAddr >>> 16], [REG_ADDR_LOW, dwordAddr & 0xffff],
		[REG_SIZE_HIGH, dwordCount >>> 16], [REG_SIZE_LOW, dwordCount & 0xffff],
		[REG_TRIGGER, TRIGGER_ROM_READ],
	], device);
}

export function buildFifoStop(device = DEVICE_ALL) {
	return buildRegisterWrite([[REG_TRIGGER, 0]], device);
}

// F0 43 1n 18 5A 10 aa bb F7: aa = register number, bb = channel. The reply is F0 43 1n 18 5A 11 aa bb n3 n2 n1 n0 F7.
// The firmware reads the register twice and answers with the 2nd value. The data low register advances the FIFO on
// every read, so one request to it uses 2 dwords and returns the low half of the 2nd one. The data high register
// returns the high half of the FIFO head and does not advance.
function buildRead(addr, device) {
	const offset = addr - 0x800000;
	return Uint8Array.from([0xf0, 0x43, 0x10 | device, 0x18, 0x5a, 0x10, offset >> 7, (offset & 0x7f) >> 1, 0xf7]);
}

export function buildRegisterRead(register, device = DEVICE_ALL) {
	return buildRead(SWP_REGISTER_ADDRS[register], device);
}

export function buildMarkerRead(markerNo, device = DEVICE_ALL) {
	return buildRead(MARKER_ADDRS[markerNo], device);
}

// {register, markerNo, value, isOk} for a register read reply, or null. One of `register` and `markerNo` is set.
// `isOk` is false when a nibble byte is out of range.
export function parseRegisterReply(message) {
	if (message.length !== 13 || message[0] !== 0xf0 || message[1] !== 0x43 || (message[2] & 0xf0) !== 0x10 || message[3] !== 0x18 || message[4] !== 0x5a || message[5] !== 0x11) {
		return null;
	}
	const offset = (message[6] << 7) | (message[7] << 1);
	const register = Object.keys(SWP_REGISTER_ADDRS).find((key) => (SWP_REGISTER_ADDRS[key] - 0x800000 === offset)) ?? null;
	const markerNo = MARKER_ADDRS.findIndex((addr) => (addr - 0x800000 === offset));
	if (!register && markerNo < 0) {
		return null;
	}
	const nibbles = Array.from(message.slice(8, 12));

	return {
		register,
		markerNo: (markerNo < 0) ? null : markerNo,
		value: (nibbles[0] << 12) | (nibbles[1] << 8) | (nibbles[2] << 4) | nibbles[3],
		isOk: nibbles.every((nibble) => (nibble < 0x10)),
	};
}
